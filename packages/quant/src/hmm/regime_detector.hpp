#pragma once
/// regime_detector.hpp — Financial Regime Detection using Gaussian HMMs
///
/// High-level API for market regime classification and trading signal generation.
///
/// Workflow:
///   1. Construct detector with desired number of regimes (e.g., 3 for bull/sideways/bear)
///   2. Train on historical data (returns, volume, spread, etc.) using train()
///   3. Query current regime via current_regime()
///   4. Get trading signal via signal()
///   5. Monitor transition risk via regime_transition_risk()
///
/// Reference: Jurafsky & Martin (2026) "Speech and Language Processing" — Appendix A
///            Rabiner (1989) "A Tutorial on Hidden Markov Models"
///            Ang & Bekaert (2002) "Regime Switches in Interest Rates"

#include "baum_welch.hpp"
#include "hmm_model.hpp"

#include <cstddef>
#include <functional>
#include <string>
#include <vector>

namespace hmm {

/// Predefined regime labels (assigned based on mean return and volatility)
/// After training, each hidden state is labeled by analyzing its Gaussian mean.
enum class RegimeLabel {
    BULL,         // positive return, low volatility
    BEAR,         // negative return, high volatility
    SIDEWAYS,     // near-zero return, moderate volatility
    HIGH_VOL,     // high volatility (direction-agnostic)
    LOW_VOL,      // low volatility, low return
    UNKNOWN,      // cannot classify
    // Extensible: add custom labels per strategy
    CUSTOM_0 = 100,
    CUSTOM_1,
    CUSTOM_2,
    CUSTOM_3,
    CUSTOM_4
};

/// Description of a detected regime
struct RegimeInfo {
    size_t state_id;
    double probability;   // γ_t(i) — posterior probability of being in this state
    RegimeLabel label;
    std::string label_str;
    Vector mean;          // Gaussian mean for this state
    Vector variance;      // Gaussian variance for this state
};

/// Trading signal derived from regime detection
struct TradingSignal {
    enum Action { LONG, SHORT, FLAT, REDUCE_LONG, REDUCE_SHORT };

    Action action;
    double confidence;       // 0.0 to 1.0
    std::string rationale;   // human-readable explanation
    size_t current_regime;
    double bull_probability;  // P(bull-like state | observations)
    double bear_probability;  // P(bear-like state | observations)
    double transition_risk;   // probability of leaving current regime in horizon
};

/// Labeling function: maps a state's Gaussian parameters to a RegimeLabel.
/// The default implementation uses mean return (dimension 0) and volatility
/// (sqrt of variance dimension 0) to classify.
using RegimeLabelFn = std::function<RegimeLabel(
    size_t state_id, const Vector& mean, const Vector& variance)>;

// ===========================================================================
// RegimeDetector — main class
// ===========================================================================
class RegimeDetector {
public:
    /// @param n_regimes  Number of hidden states (e.g., 3 for bull/sideways/bear)
    /// @param n_features Number of observation dimensions
    explicit RegimeDetector(size_t n_regimes = 3, size_t n_features = 4);

    // --- Training ---

    /// Train the HMM on historical observation sequences.
    /// Each sequence (e.g., one trading day, one asset) is a vector of
    /// observation vectors.
    ///
    /// @param observations  Training sequences
    /// @param config  Baum-Welch training config (tolerance, max_iter, etc.)
    /// @return Final log-likelihood of the trained model
    double train(const std::vector<std::vector<Vector>>& observations,
                 const BaumWelchConfig& config = BaumWelchConfig{});

    /// Train on a single long observation sequence (e.g., daily data for one asset).
    /// Internally segments into overlapping windows for multi-sequence training.
    ///
    /// @param observations  Single long observation sequence
    /// @param window_size  Length of each training window
    /// @param step_size  Step between windows
    /// @param config  Baum-Welch config
    /// @return Final log-likelihood
    double train_single(const std::vector<Vector>& observations,
                        size_t window_size = 100,
                        size_t step_size = 50,
                        const BaumWelchConfig& config = BaumWelchConfig{});

    // --- Inference ---

    /// Determine the current regime given recent observations.
    /// Runs Viterbi decoding on the observation window and returns the
    /// final state's information.
    ///
    /// @param recent_observations  Most recent observation vectors (window)
    /// @return RegimeInfo for the current state
    RegimeInfo current_regime(
        const std::vector<Vector>& recent_observations) const;

    /// Compute the full posterior distribution over states at the current time.
    ///
    /// @param recent_observations  Recent observation window
    /// @return Vector of size N with P(q_t = i | observations)
    Vector state_posterior(
        const std::vector<Vector>& recent_observations) const;

    /// Estimate the probability of exiting the current regime within `horizon`
    /// time steps. Uses the transition matrix: P(exit within H steps | state i)
    /// = 1 - (A^H)_{ii}.
    ///
    /// @param current_state  Current state index
    /// @param horizon  Number of future time steps
    /// @return Probability of regime change within horizon
    double regime_transition_risk(size_t current_state, size_t horizon) const;

    // --- Trading Signal ---

    /// Generate a trading signal based on current regime assessment.
    /// Strategy: LONG in bull, SHORT in bear, FLAT in sideways.
    /// REDUCE when transition risk is elevated.
    ///
    /// @param recent_observations  Recent observations
    /// @param horizon  Risk horizon for transition assessment
    /// @return TradingSignal with action, confidence, rationale
    TradingSignal signal(const std::vector<Vector>& recent_observations,
                         size_t horizon = 5) const;

    // --- Accessors ---

    const GaussianHMM& model() const { return model_; }
    GaussianHMM& model() { return model_; }

    bool is_trained() const { return trained_; }

    /// Get the label for each state (after training + labeling)
    const std::vector<RegimeLabel>& state_labels() const {
        return state_labels_;
    }

    /// Get human-readable label names
    std::vector<std::string> state_label_strings() const;

    /// Set a custom labeling function (called after training)
    void set_labeler(RegimeLabelFn labeler);

private:
    GaussianHMM model_;
    bool trained_ = false;
    std::vector<RegimeLabel> state_labels_;
    RegimeLabelFn labeler_;

    /// Default labeler: uses mean return (dim 0) and vol (dim 0)
    RegimeLabel default_labeler(size_t state_id, const Vector& mean,
                                const Vector& variance) const;

    /// Auto-label states after training
    void auto_label();
};

// ===========================================================================
// Utility: generate observation features from price data
// ===========================================================================

/// Compute multi-dimensional observation features from price/volume data.
/// Features (order matters for default regime labeling):
///   0: log return
///   1: volume change (relative to moving average)
///   2: high-low range / close (proxy for intraday volatility contribution)
///   3: close location within high-low range
///
/// Returns a vector of observation Vectors suitable for HMM training.
std::vector<Vector> compute_features(
    const std::vector<double>& close_prices,
    const std::vector<double>& volumes,
    const std::vector<double>& highs,
    const std::vector<double>& lows,
    size_t volume_ma_window = 20);

} // namespace hmm
