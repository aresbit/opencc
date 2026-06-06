/// regime_detector.cpp — Financial Regime Detection implementation

#include "regime_detector.hpp"
#include "forward.hpp"
#include "viterbi.hpp"

#include <algorithm>
#include <cmath>
#include <sstream>
#include <stdexcept>

namespace hmm {

// ===========================================================================
// Utility: regime label to string
// ===========================================================================
static std::string regime_label_to_string(RegimeLabel label) {
    switch (label) {
        case RegimeLabel::BULL:     return "BULL";
        case RegimeLabel::BEAR:     return "BEAR";
        case RegimeLabel::SIDEWAYS: return "SIDEWAYS";
        case RegimeLabel::HIGH_VOL: return "HIGH_VOL";
        case RegimeLabel::LOW_VOL:  return "LOW_VOL";
        case RegimeLabel::UNKNOWN:  return "UNKNOWN";
        default: return "CUSTOM_" + std::to_string(
                       static_cast<int>(label) -
                       static_cast<int>(RegimeLabel::CUSTOM_0));
    }
}

// ===========================================================================
// RegimeDetector
// ===========================================================================

RegimeDetector::RegimeDetector(size_t n_regimes, size_t n_features)
    : model_(n_regimes, n_features) {
    // Default labeler: state with highest mean return is BULL,
    // state with lowest mean return is BEAR, middle is SIDEWAYS
    set_labeler(nullptr); // triggers default
}

void RegimeDetector::set_labeler(RegimeLabelFn labeler) {
    if (labeler) {
        labeler_ = std::move(labeler);
    } else {
        labeler_ = [this](size_t state_id, const Vector& mean,
                          const Vector& variance) -> RegimeLabel {
            return this->default_labeler(state_id, mean, variance);
        };
    }
}

RegimeLabel RegimeDetector::default_labeler(
    size_t /*state_id*/, const Vector& mean,
    const Vector& variance) const {

    // Classify based on mean return (dimension 0) and volatility (dimension 0)
    double ret = (mean.rows() > 0) ? mean(0, 0) : 0.0;
    double vol = (variance.rows() > 0) ? std::sqrt(std::max(variance(0, 0), 0.0))
                                        : 0.0;

    // Thresholds for classification
    double ret_threshold = 0.0005; // 5 bps daily

    if (ret > ret_threshold && vol < 0.02) {
        return RegimeLabel::BULL;
    } else if (ret < -ret_threshold && vol > 0.015) {
        return RegimeLabel::BEAR;
    } else if (std::abs(ret) <= ret_threshold) {
        return RegimeLabel::SIDEWAYS;
    } else if (vol > 0.025) {
        return RegimeLabel::HIGH_VOL;
    } else if (vol < 0.01) {
        return RegimeLabel::LOW_VOL;
    }

    return RegimeLabel::UNKNOWN;
}

void RegimeDetector::auto_label() {
    state_labels_.resize(model_.n_states);
    for (size_t i = 0; i < model_.n_states; ++i) {
        state_labels_[i] = labeler_(i, model_.means[i], model_.covars[i]);
    }
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

double RegimeDetector::train(
    const std::vector<std::vector<Vector>>& observations,
    const BaumWelchConfig& config) {

    auto result = baum_welch_train(observations, model_.n_states,
                                   config, &model_);
    model_ = result.model;
    trained_ = true;
    auto_label();
    return result.final_log_likelihood;
}

double RegimeDetector::train_single(
    const std::vector<Vector>& observations,
    size_t window_size, size_t step_size,
    const BaumWelchConfig& config) {

    if (observations.size() < window_size) {
        throw std::invalid_argument(
            "train_single: observations shorter than window_size");
    }

    // Segment into overlapping windows
    std::vector<std::vector<Vector>> windows;
    for (size_t start = 0; start + window_size <= observations.size();
         start += step_size) {
        windows.emplace_back(
            observations.begin() + static_cast<long>(start),
            observations.begin() + static_cast<long>(start + window_size));
    }

    return train(windows, config);
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

RegimeInfo RegimeDetector::current_regime(
    const std::vector<Vector>& recent_observations) const {

    if (!trained_) {
        throw std::runtime_error("RegimeDetector not trained");
    }
    if (recent_observations.empty()) {
        throw std::invalid_argument("current_regime: empty observations");
    }

    RegimeInfo info;
    info.state_id = 0;
    info.probability = 0.0;
    info.label = RegimeLabel::UNKNOWN;
    info.label_str = "UNKNOWN";

    // Run Viterbi to find most likely state sequence
    ViterbiResult vit = viterbi_decode(model_, recent_observations);

    // The final state in the best path
    info.state_id = vit.path.back();

    // Compute posterior probability using forward algorithm
    ForwardResult fwd = forward_algorithm(model_, recent_observations);
    if (!std::isinf(fwd.log_likelihood)) {
        // γ_T(i) = α̂_T(i) (already normalized, row sums to 1)
        info.probability = fwd.alpha.back()(info.state_id, 0);
    }

    if (info.state_id < state_labels_.size()) {
        info.label = state_labels_[info.state_id];
    }
    info.label_str = regime_label_to_string(info.label);

    info.mean = model_.means[info.state_id];
    info.variance = model_.covars[info.state_id];

    return info;
}

Vector RegimeDetector::state_posterior(
    const std::vector<Vector>& recent_observations) const {

    if (!trained_) {
        throw std::runtime_error("RegimeDetector not trained");
    }

    ForwardResult fwd = forward_algorithm(model_, recent_observations);
    if (std::isinf(fwd.log_likelihood)) {
        // Degenerate: uniform
        Vector post(model_.n_states, 1);
        post.fill(1.0 / static_cast<double>(model_.n_states));
        return post;
    }

    // α̂_T(i) is already normalized → it IS the posterior
    return fwd.alpha.back();
}

double RegimeDetector::regime_transition_risk(
    size_t current_state, size_t horizon) const {

    if (!trained_) {
        throw std::runtime_error("RegimeDetector not trained");
    }
    if (horizon == 0) return 0.0;

    // Compute A^horizon to get H-step transition probabilities
    // P(stay in state i for H steps) = (A^H)_{ii}
    // P(exit within H steps) = 1 - (A^H)_{ii}
    //
    // We compute matrix power by repeated squaring.

    // Copy A
    Matrix power = model_.A; // start with A^1
    Matrix result(model_.n_states, model_.n_states);
    // result = identity
    for (size_t i = 0; i < model_.n_states; ++i) {
        for (size_t j = 0; j < model_.n_states; ++j) {
            result(i, j) = (i == j) ? 1.0 : 0.0;
        }
    }

    size_t h = horizon;
    Matrix temp = power;
    while (h > 0) {
        if (h & 1) {
            result = matmul(result, temp);
        }
        temp = matmul(temp, temp);
        h >>= 1;
    }

    double stay_prob = result(current_state, current_state);
    return 1.0 - stay_prob;
}

// ---------------------------------------------------------------------------
// Trading Signal
// ---------------------------------------------------------------------------

TradingSignal RegimeDetector::signal(
    const std::vector<Vector>& recent_observations,
    size_t horizon) const {

    TradingSignal sig;
    sig.action = TradingSignal::FLAT;
    sig.confidence = 0.0;
    sig.rationale = "No trained model available";

    if (!trained_) return sig;

    // Get current regime
    RegimeInfo regime = current_regime(recent_observations);
    sig.current_regime = regime.state_id;

    // Get full posterior
    Vector posterior = state_posterior(recent_observations);

    // Compute bull/bear probabilities (sum posterior of states with those labels)
    double bull_prob = 0.0, bear_prob = 0.0;
    for (size_t i = 0; i < model_.n_states; ++i) {
        if (state_labels_[i] == RegimeLabel::BULL)
            bull_prob += posterior(i, 0);
        else if (state_labels_[i] == RegimeLabel::BEAR)
            bear_prob += posterior(i, 0);
    }
    sig.bull_probability = bull_prob;
    sig.bear_probability = bear_prob;

    // Compute transition risk
    sig.transition_risk = regime_transition_risk(regime.state_id, horizon);

    // Decision logic
    std::ostringstream rationale;

    switch (regime.label) {
        case RegimeLabel::BULL:
            if (sig.transition_risk > 0.5) {
                sig.action = TradingSignal::REDUCE_LONG;
                sig.confidence = bull_prob * (1.0 - sig.transition_risk);
                rationale << "BULL regime but high transition risk ("
                          << sig.transition_risk << "). Reduce long exposure.";
            } else {
                sig.action = TradingSignal::LONG;
                sig.confidence = bull_prob * (1.0 - sig.transition_risk);
                rationale << "BULL regime with low transition risk ("
                          << sig.transition_risk << "). Maintain long.";
            }
            break;

        case RegimeLabel::BEAR:
            if (sig.transition_risk > 0.5) {
                sig.action = TradingSignal::REDUCE_SHORT;
                sig.confidence = bear_prob * (1.0 - sig.transition_risk);
                rationale << "BEAR regime but high transition risk ("
                          << sig.transition_risk << "). Reduce short exposure.";
            } else {
                sig.action = TradingSignal::SHORT;
                sig.confidence = bear_prob * (1.0 - sig.transition_risk);
                rationale << "BEAR regime with low transition risk ("
                          << sig.transition_risk << "). Maintain short.";
            }
            break;

        case RegimeLabel::SIDEWAYS:
            sig.action = TradingSignal::FLAT;
            sig.confidence = 1.0 - std::max(bull_prob, bear_prob);
            rationale << "SIDEWAYS regime. No directional edge.";
            break;

        case RegimeLabel::HIGH_VOL:
            sig.action = TradingSignal::FLAT;
            sig.confidence = 0.3;
            rationale << "HIGH_VOL regime. Elevated risk, stay flat.";
            break;

        case RegimeLabel::LOW_VOL:
            // Low vol: if there's a slight directional lean, take it
            if (bull_prob > 0.6) {
                sig.action = TradingSignal::LONG;
                sig.confidence = bull_prob * 0.5;
                rationale << "LOW_VOL with bull lean. Cautious long.";
            } else if (bear_prob > 0.6) {
                sig.action = TradingSignal::SHORT;
                sig.confidence = bear_prob * 0.5;
                rationale << "LOW_VOL with bear lean. Cautious short.";
            } else {
                sig.action = TradingSignal::FLAT;
                sig.confidence = 0.5;
                rationale << "LOW_VOL, no clear direction. Flat.";
            }
            break;

        default:
            sig.action = TradingSignal::FLAT;
            sig.confidence = 0.1;
            rationale << "Unknown/ambiguous regime. Flat.";
            break;
    }

    sig.rationale = rationale.str();
    return sig;
}

std::vector<std::string> RegimeDetector::state_label_strings() const {
    std::vector<std::string> labels;
    labels.reserve(state_labels_.size());
    for (auto label : state_labels_) {
        labels.push_back(regime_label_to_string(label));
    }
    return labels;
}

// ===========================================================================
// compute_features — financial feature engineering
// ===========================================================================

std::vector<Vector> compute_features(
    const std::vector<double>& close_prices,
    const std::vector<double>& volumes,
    const std::vector<double>& highs,
    const std::vector<double>& lows,
    size_t volume_ma_window) {

    size_t n = close_prices.size();
    if (n < 2) return {};

    // Validate all vectors have same length
    if (volumes.size() != n || highs.size() != n || lows.size() != n) {
        throw std::invalid_argument("compute_features: input vector size mismatch");
    }

    // Precompute volume moving average
    std::vector<double> vol_ma(n, 0.0);
    for (size_t i = 0; i < n; ++i) {
        size_t start = (i >= volume_ma_window) ? (i - volume_ma_window) : 0;
        double sum = 0.0;
        for (size_t j = start; j <= i; ++j) {
            sum += volumes[j];
        }
        vol_ma[i] = sum / static_cast<double>(i - start + 1);
    }

    std::vector<Vector> features;
    features.reserve(n);

    for (size_t i = 0; i < n; ++i) {
        Vector obs(4, 1); // 4-dimensional observation

        // Feature 0: log return (relative to previous close)
        if (i > 0 && close_prices[i - 1] > 0) {
            obs(0, 0) = std::log(close_prices[i] / close_prices[i - 1]);
        } else {
            obs(0, 0) = 0.0;
        }

        // Feature 1: relative volume (volume / volume_MA - 1)
        if (vol_ma[i] > 0) {
            obs(1, 0) = volumes[i] / vol_ma[i] - 1.0;
        } else {
            obs(1, 0) = 0.0;
        }

        // Feature 2: daily range / close (volatility proxy)
        if (close_prices[i] > 0) {
            obs(2, 0) = (highs[i] - lows[i]) / close_prices[i];
        } else {
            obs(2, 0) = 0.0;
        }

        // Feature 3: close location within range [0,1]
        // 1 = closed at high, 0 = closed at low
        double range = highs[i] - lows[i];
        if (range > 0) {
            obs(3, 0) = (close_prices[i] - lows[i]) / range;
        } else {
            obs(3, 0) = 0.5; // midpoint if no range
        }

        features.push_back(obs);
    }

    return features;
}

} // namespace hmm
