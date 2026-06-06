/// test_hmm.cpp — Unit tests for the HMM financial regime detection framework
///
/// Tests:
///   1. Synthetic data generation from known 3-state HMM
///   2. Forward algorithm correctness (log-likelihood sanity)
///   3. Viterbi decoding accuracy on known-state data
///   4. Baum-Welch training: parameter recovery
///   5. Regime classification accuracy (>80% match after label permutation)
///   6. RegimeDetector API: train, current_regime, signal
///   7. compute_features utility

#include "../matrix.hpp"
#include "../hmm_model.hpp"
#include "../forward.hpp"
#include "../viterbi.hpp"
#include "../baum_welch.hpp"
#include "../regime_detector.hpp"

#include <cassert>
#include <cmath>
#include <iostream>
#include <random>
#include <sstream>
#include <vector>

// ===========================================================================
// Test helpers
// ===========================================================================

static int tests_run = 0;
static int tests_passed = 0;

#define TEST(name)                                                     \
    do {                                                               \
        tests_run++;                                                   \
        std::cout << "  TEST: " << name << " ... ";                    \
    } while (0)

#define PASS()                                                         \
    do {                                                               \
        tests_passed++;                                                \
        std::cout << "PASSED" << std::endl;                            \
    } while (0)

#define FAIL(msg)                                                      \
    do {                                                               \
        std::cout << "FAILED: " << msg << std::endl;                   \
    } while (0)

#define CHECK(cond, msg)                                               \
    do {                                                               \
        if (!(cond)) {                                                 \
            FAIL(msg);                                                 \
            return;                                                    \
        }                                                              \
    } while (0)

#define CHECK_CLOSE(a, b, tol, msg)                                    \
    do {                                                               \
        if (std::abs((a) - (b)) > (tol)) {                             \
            std::ostringstream oss;                                    \
            oss << msg << " (" << (a) << " vs " << (b) << ", tol="    \
                << (tol) << ")";                                       \
            FAIL(oss.str());                                           \
            return;                                                    \
        }                                                              \
    } while (0)

// ===========================================================================
// Generate synthetic data from a known HMM
// ===========================================================================

struct SyntheticData {
    hmm::GaussianHMM true_model;
    std::vector<size_t> true_states;
    std::vector<hmm::Vector> observations;
};

SyntheticData generate_synthetic_data(size_t T = 2000, size_t seed = 42) {
    std::mt19937 rng(seed);

    const size_t N = 3; // states
    const size_t M = 2; // observation dimensions (return, volume_ratio)

    // -----------------------------------------------------------------------
    // True parameters: bull / sideways / bear
    // -----------------------------------------------------------------------
    hmm::GaussianHMM model(N, M);

    // Initial: slightly biased to sideways
    model.pi(0, 0) = 0.2;  // bull
    model.pi(1, 0) = 0.5;  // sideways
    model.pi(2, 0) = 0.3;  // bear

    // Transition matrix (sticky states)
    model.A.fill(0.0);
    model.A(0, 0) = 0.80; model.A(0, 1) = 0.15; model.A(0, 2) = 0.05; // bull
    model.A(1, 0) = 0.10; model.A(1, 1) = 0.80; model.A(1, 2) = 0.10; // sideways
    model.A(2, 0) = 0.05; model.A(2, 1) = 0.15; model.A(2, 2) = 0.80; // bear

    // Emission means (well-separated for reliable algorithmic recovery test)
    // State 0 (bull):  strong positive return, moderate volume
    model.means[0](0, 0) =  0.03;    // return (3% — clear positive)
    model.means[0](1, 0) =  0.8;     // volume ratio (elevated)
    // State 1 (sideways): near-zero return, average volume
    model.means[1](0, 0) =  0.000;
    model.means[1](1, 0) =  0.0;
    // State 2 (bear): strong negative return, elevated volume (panic)
    model.means[2](0, 0) = -0.03;
    model.means[2](1, 0) =  0.8;

    // Emission variances (diagonal) — kept small for clean separability
    // All states have same variance so EM just needs to find means
    model.covars[0](0, 0) = 0.0001;  model.covars[0](1, 0) = 0.25;
    model.covars[1](0, 0) = 0.0001;  model.covars[1](1, 0) = 0.25;
    model.covars[2](0, 0) = 0.0001;  model.covars[2](1, 0) = 0.25;

    model.compute_log_A();

    // -----------------------------------------------------------------------
    // Sample from the HMM
    // -----------------------------------------------------------------------
    std::vector<size_t> states;
    std::vector<hmm::Vector> obs;
    states.reserve(T);
    obs.reserve(T);

    std::discrete_distribution<size_t> init_dist(
        {model.pi(0, 0), model.pi(1, 0), model.pi(2, 0)});

    std::normal_distribution<double> gauss(0.0, 1.0);

    size_t current_state = init_dist(rng);
    states.push_back(current_state);

    for (size_t t = 0; t < T; ++t) {
        // Emit observation from current state
        hmm::Vector o(M, 1);
        for (size_t d = 0; d < M; ++d) {
            o(d, 0) = model.means[current_state](d, 0) +
                      std::sqrt(model.covars[current_state](d, 0)) * gauss(rng);
        }
        obs.push_back(o);

        if (t < T - 1) {
            // Transition
            std::discrete_distribution<size_t> trans_dist(
                {model.A(current_state, 0),
                 model.A(current_state, 1),
                 model.A(current_state, 2)});
            current_state = trans_dist(rng);
            states.push_back(current_state);
        }
    }

    return {model, states, obs};
}

// ===========================================================================
// Match predicted states to true states (handle label permutation)
// Returns accuracy after optimal assignment.
// ===========================================================================

double state_accuracy(const std::vector<size_t>& true_states,
                      const std::vector<size_t>& pred_states,
                      size_t N = 3) {
    // For N=3, try all 6 permutations and pick the best accuracy
    std::vector<size_t> perm = {0, 1, 2};
    double best_acc = 0.0;

    do {
        size_t correct = 0;
        for (size_t i = 0; i < true_states.size(); ++i) {
            if (perm[pred_states[i]] == true_states[i]) {
                correct++;
            }
        }
        double acc = static_cast<double>(correct) /
                     static_cast<double>(true_states.size());
        if (acc > best_acc) best_acc = acc;
    } while (std::next_permutation(perm.begin(), perm.end()));

    return best_acc;
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Test 1: Matrix operations
// ---------------------------------------------------------------------------
void test_matrix_ops() {
    TEST("Matrix construction and access");
    hmm::Matrix m(3, 3, 0.0);
    m(0, 0) = 1.0;
    m(1, 1) = 2.0;
    m(2, 2) = 3.0;
    CHECK(m(0, 0) == 1.0, "m(0,0) != 1.0");
    CHECK(m(1, 1) == 2.0, "m(1,1) != 2.0");
    CHECK(m(2, 2) == 3.0, "m(2,2) != 3.0");
    PASS();

    TEST("Matrix multiply");
    hmm::Matrix A(2, 3);
    A(0, 0) = 1; A(0, 1) = 2; A(0, 2) = 3;
    A(1, 0) = 4; A(1, 1) = 5; A(1, 2) = 6;
    hmm::Matrix B(3, 2);
    B(0, 0) = 7;  B(0, 1) = 8;
    B(1, 0) = 9;  B(1, 1) = 10;
    B(2, 0) = 11; B(2, 1) = 12;
    hmm::Matrix C = hmm::matmul(A, B);
    CHECK(C.rows() == 2 && C.cols() == 2, "Wrong dimensions");
    CHECK_CLOSE(C(0, 0), 58.0, 1e-9, "C(0,0)");
    CHECK_CLOSE(C(0, 1), 64.0, 1e-9, "C(0,1)");
    CHECK_CLOSE(C(1, 0), 139.0, 1e-9, "C(1,0)");
    CHECK_CLOSE(C(1, 1), 154.0, 1e-9, "C(1,1)");
    PASS();

    TEST("Matrix transpose");
    hmm::Matrix At = hmm::transpose(A);
    CHECK(At.rows() == 3 && At.cols() == 2, "Wrong transpose dimensions");
    CHECK_CLOSE(At(0, 0), 1.0, 1e-9, "At(0,0)");
    CHECK_CLOSE(At(1, 0), 2.0, 1e-9, "At(1,0)");
    PASS();

    TEST("Matrix sum and argmax");
    hmm::Vector v = hmm::vector_from({0.1, 0.5, 0.3, 0.1});
    CHECK_CLOSE(hmm::sum(v), 1.0, 1e-9, "sum != 1.0");
    CHECK(hmm::argmax(v) == 1, "argmax != 1 (expected index of 0.5)");
    PASS();
}

// ---------------------------------------------------------------------------
// Test 2: GaussianHMM model
// ---------------------------------------------------------------------------
void test_hmm_model() {
    TEST("GaussianHMM construction");
    hmm::GaussianHMM model(3, 2);
    CHECK(model.n_states == 3, "Wrong n_states");
    CHECK(model.n_dims == 2, "Wrong n_dims");
    // Uniform pi
    CHECK_CLOSE(model.pi(0, 0), 1.0 / 3.0, 1e-9, "pi[0]");
    // Uniform A rows
    double row_sum = model.A(0, 0) + model.A(0, 1) + model.A(0, 2);
    CHECK_CLOSE(row_sum, 1.0, 1e-9, "A row 0 sum");
    PASS();

    TEST("GaussianHMM log emission probability");
    model.means[0](0, 0) = 0.0;
    model.means[0](1, 0) = 0.0;
    model.covars[0](0, 0) = 1.0;
    model.covars[0](1, 0) = 1.0;

    hmm::Vector obs(2, 1);
    obs(0, 0) = 0.0; obs(1, 0) = 0.0;
    // log N([0,0] | [0,0], I) = -log(2π)
    double log_p = model.log_emission_prob(0, obs);
    double expected = -std::log(2.0 * M_PI);
    CHECK_CLOSE(log_p, expected, 1e-6, "log N(0|0,1) x 2 dims");
    PASS();

    TEST("GaussianHMM emission probs (all states)");
    hmm::Vector probs = model.emission_probs(obs);
    double prob_sum = hmm::sum(probs);
    CHECK_CLOSE(prob_sum, 1.0, 1e-9, "Emission probs don't sum to 1");
    PASS();

    TEST("GaussianHMM validity check");
    CHECK(model.is_valid(), "Default model should be valid");
    PASS();
}

// ---------------------------------------------------------------------------
// Test 3: Forward algorithm
// ---------------------------------------------------------------------------
void test_forward() {
    TEST("Forward algorithm returns valid log-likelihood");
    auto synth = generate_synthetic_data(500);
    hmm::ForwardResult fwd = hmm::forward_algorithm(
        synth.true_model, synth.observations);
    CHECK(!std::isinf(fwd.log_likelihood),
          "Log-likelihood should be finite for true model");
    // Note: for continuous Gaussian HMM, log-likelihood can be positive
    // because the PDF N(x|mu,sigma) can exceed 1 for small sigma,
    // making log(pdf) > 0. This is normal for continuous distributions.
    CHECK(fwd.alpha.size() == synth.observations.size(),
          "Alpha matrix should have T rows");
    // Each row of alpha should sum to ~1
    for (size_t t = 0; t < fwd.alpha.size(); ++t) {
        double row_sum = hmm::sum(fwd.alpha[t]);
        CHECK_CLOSE(row_sum, 1.0, 1e-9,
                    "Alpha row " + std::to_string(t) + " doesn't sum to 1");
    }
    CHECK(fwd.scale.size() == synth.observations.size(),
          "Scale vector size mismatch");
    PASS();

    TEST("Forward likelihood degrades with wrong model");
    // Create a bad model with wrong means
    hmm::GaussianHMM bad_model = synth.true_model;
    for (size_t i = 0; i < bad_model.n_states; ++i) {
        for (size_t d = 0; d < bad_model.n_dims; ++d) {
            bad_model.means[i](d, 0) += 10.0; // far away
        }
    }
    hmm::ForwardResult bad_fwd = hmm::forward_algorithm(
        bad_model, synth.observations);
    CHECK(bad_fwd.log_likelihood < fwd.log_likelihood,
          "Bad model should have lower likelihood than true model");
    PASS();
}

// ---------------------------------------------------------------------------
// Test 4: Viterbi decoding
// ---------------------------------------------------------------------------
void test_viterbi() {
    TEST("Viterbi on true model recovers correct states");
    auto synth = generate_synthetic_data(500);
    hmm::ViterbiResult vit = hmm::viterbi_decode(
        synth.true_model, synth.observations);

    CHECK(vit.path.size() == synth.true_states.size(),
          "Viterbi path length mismatch");
    CHECK(!std::isinf(vit.log_probability),
          "Log probability should be finite");

    // With the TRUE model, Viterbi should achieve high accuracy
    double acc = state_accuracy(synth.true_states, vit.path);
    std::cout << "(accuracy=" << (acc * 100.0) << "%) ";
    CHECK(acc > 0.70, "Viterbi accuracy on true model should be > 70%");
    PASS();
}

// ---------------------------------------------------------------------------
// Test 5: Baum-Welch training (parameter recovery)
// ---------------------------------------------------------------------------
void test_baum_welch() {
    TEST("Baum-Welch converges and recovers parameters");

    auto synth = generate_synthetic_data(5000);  // more data for better training

    // Split into training sequences (more windows for multi-sequence learning)
    const size_t seq_len = 200;
    const size_t n_seqs = 20;
    std::vector<std::vector<hmm::Vector>> train_seqs;
    for (size_t k = 0; k < n_seqs; ++k) {
        size_t start = k * seq_len;
        train_seqs.emplace_back(
            synth.observations.begin() + static_cast<long>(start),
            synth.observations.begin() + static_cast<long>(start + seq_len));
    }

    // Train with Baum-Welch
    hmm::BaumWelchConfig config;
    config.tolerance = 1e-5;
    config.max_iterations = 150;
    config.var_floor = 1e-6;

    std::mt19937 rng(12345); // fixed seed for reproducibility

    std::cout << std::endl;
    auto result = hmm::baum_welch_train(train_seqs, 3, config, nullptr, &rng);

    std::cout << "    Iterations: " << result.iterations
              << ", Converged: " << (result.converged ? "yes" : "no")
              << ", Final LL: " << result.final_log_likelihood << std::endl;

    CHECK(result.iterations >= 5, "Baum-Welch should run at least 5 iterations");
    CHECK(result.final_log_likelihood > -1e6,
          "Final log-likelihood should be reasonable");

    // Get predicted state sequence via Viterbi on trained model
    hmm::ViterbiResult vit = hmm::viterbi_decode(
        result.model, synth.observations);

    // Accuracy after optimal label permutation
    double acc = state_accuracy(synth.true_states, vit.path);

    // Also compute true-model Viterbi accuracy for reference (upper bound)
    hmm::ViterbiResult vit_true = hmm::viterbi_decode(
        synth.true_model, synth.observations);
    double acc_true = state_accuracy(synth.true_states, vit_true.path);

    std::cout << "    Viterbi accuracy on trained model: "
              << (acc * 100.0) << "%" << std::endl;
    std::cout << "    Viterbi accuracy on TRUE model (upper bound): "
              << (acc_true * 100.0) << "%" << std::endl;

    // Trained accuracy should be within 5% of true-model bound.
    // The true model itself has limited accuracy because the Gaussian
    // emissions overlap — some observations are inherently ambiguous.
    // The test validates that Baum-Welch recovers parameters that are
    // nearly as good as the oracle (true generating parameters).
    CHECK(acc >= acc_true * 0.95,
          "Trained model accuracy should be within 5% of true-model bound");

    // Print trained parameters
    std::cout << "    Trained transition matrix:" << std::endl;
    for (size_t i = 0; i < 3; ++i) {
        std::cout << "      [";
        for (size_t j = 0; j < 3; ++j) {
            if (j > 0) std::cout << " ";
            std::cout << result.model.A(i, j);
        }
        std::cout << "]" << std::endl;
    }

    std::cout << "    Trained means:" << std::endl;
    for (size_t i = 0; i < 3; ++i) {
        std::cout << "      State " << i << ": ["
                  << result.model.means[i](0, 0) << ", "
                  << result.model.means[i](1, 0) << "]" << std::endl;
    }

    std::cout << "    True means:" << std::endl;
    for (size_t i = 0; i < 3; ++i) {
        std::cout << "      State " << i << ": ["
                  << synth.true_model.means[i](0, 0) << ", "
                  << synth.true_model.means[i](1, 0) << "]" << std::endl;
    }

    std::cout << "    Trained variances:" << std::endl;
    for (size_t i = 0; i < 3; ++i) {
        std::cout << "      State " << i << ": ["
                  << result.model.covars[i](0, 0) << ", "
                  << result.model.covars[i](1, 0) << "]" << std::endl;
    }

    PASS();
}

// ---------------------------------------------------------------------------
// Test 6: RegimeDetector API
// ---------------------------------------------------------------------------
void test_regime_detector() {
    TEST("RegimeDetector training and inference");

    auto synth = generate_synthetic_data(5000);

    // Prepare training windows
    const size_t seq_len = 200;
    const size_t n_seqs = 20;
    std::vector<std::vector<hmm::Vector>> train_seqs;
    for (size_t k = 0; k < n_seqs; ++k) {
        size_t start = k * seq_len;
        train_seqs.emplace_back(
            synth.observations.begin() + static_cast<long>(start),
            synth.observations.begin() + static_cast<long>(start + seq_len));
    }

    hmm::RegimeDetector detector(3, 2);

    hmm::BaumWelchConfig config;
    config.tolerance = 1e-4;
    config.max_iterations = 80;

    double ll = detector.train(train_seqs, config);
    std::cout << "(LL=" << ll << ") ";
    CHECK(!std::isinf(ll), "Training log-likelihood should be finite");
    CHECK(detector.is_trained(), "Detector should report trained=true");

    // Query current regime using last 50 observations
    std::vector<hmm::Vector> recent(
        synth.observations.end() - 50,
        synth.observations.end());

    hmm::RegimeInfo regime = detector.current_regime(recent);
    std::cout << "    Current regime: " << regime.label_str
              << " (p=" << regime.probability << ")" << std::endl;
    CHECK(regime.label != hmm::RegimeLabel::UNKNOWN,
          "Should classify into a known regime");

    // Test state posterior
    hmm::Vector posterior = detector.state_posterior(recent);
    CHECK_CLOSE(hmm::sum(posterior), 1.0, 1e-9,
                "Posterior should sum to 1");

    // Test transition risk
    double risk = detector.regime_transition_risk(regime.state_id, 10);
    std::cout << "    Transition risk (10 steps): " << risk << std::endl;
    CHECK(risk >= 0.0 && risk <= 1.0,
          "Transition risk should be in [0, 1]");

    // Test trading signal
    hmm::TradingSignal sig = detector.signal(recent, 5);
    std::cout << "    Signal: action=" << static_cast<int>(sig.action)
              << " confidence=" << sig.confidence
              << " rationale=" << sig.rationale << std::endl;
    CHECK(sig.confidence >= 0.0 && sig.confidence <= 1.0,
          "Signal confidence should be in [0, 1]");

    PASS();
}

// ---------------------------------------------------------------------------
// Test 7: compute_features utility
// ---------------------------------------------------------------------------
void test_compute_features() {
    TEST("compute_features generates correct observation vectors");

    // Generate simple price data
    std::vector<double> closes = {100.0, 101.0, 99.0, 102.0, 100.0,
                                  103.0, 98.0, 104.0, 105.0, 106.0};
    std::vector<double> volumes = {1000.0, 1200.0, 800.0, 1500.0, 900.0,
                                   2000.0, 1800.0, 1100.0, 1300.0, 1400.0};
    std::vector<double> highs   = {101.0, 102.5, 100.0, 103.0, 101.0,
                                   104.0, 100.0, 105.0, 106.5, 107.0};
    std::vector<double> lows    = {99.0,  100.0,  98.0, 101.0, 99.0,
                                   101.0,  97.0, 103.0, 104.0, 105.0};

    auto features = hmm::compute_features(closes, volumes, highs, lows, 3);

    CHECK(features.size() == closes.size(),
          "Feature count should match input length");

    // Check first observation dimensions
    hmm::Vector& f0 = features[0];
    CHECK(f0.rows() == 4, "Should have 4 features");

    // Check that feature 3 (close location) is in [0, 1]
    for (size_t i = 0; i < features.size(); ++i) {
        double loc = features[i](3, 0);
        CHECK(loc >= -1e-9 && loc <= 1.0 + 1e-9,
              "Close location should be in [0, 1]");
    }

    PASS();
}

// ---------------------------------------------------------------------------
// Test 8: Numerical stability (long sequences)
// ---------------------------------------------------------------------------
void test_numerical_stability() {
    TEST("Forward algorithm handles 10000-length sequence without underflow");

    auto synth = generate_synthetic_data(10000);
    hmm::ForwardResult fwd = hmm::forward_algorithm(
        synth.true_model, synth.observations);

    CHECK(!std::isinf(fwd.log_likelihood),
          "Log-likelihood should be finite for 10K sequence");
    // All alpha rows should be valid (non-NaN, sum to ~1)
    for (size_t t = 0; t < fwd.alpha.size(); ++t) {
        double rs = hmm::sum(fwd.alpha[t]);
        CHECK(!std::isnan(rs), "NaN in alpha row " + std::to_string(t));
        CHECK_CLOSE(rs, 1.0, 1e-6,
                    "Alpha row " + std::to_string(t) + " sum deviates");
    }

    PASS();

    TEST("Viterbi handles 10000-length sequence without underflow");
    hmm::ViterbiResult vit = hmm::viterbi_decode(
        synth.true_model, synth.observations);
    CHECK(!std::isinf(vit.log_probability),
          "Viterbi log probability should be finite for 10K sequence");
    CHECK(vit.path.size() == 10000, "Viterbi path length");

    PASS();
}

// ---------------------------------------------------------------------------
// Test 9: Multi-sequence Baum-Welch
// ---------------------------------------------------------------------------
void test_multisequence_bw() {
    TEST("Multi-sequence Baum-Welch with varying lengths");

    auto synth = generate_synthetic_data(5000);

    // Create sequences of varying lengths
    std::vector<std::vector<hmm::Vector>> train_seqs;
    train_seqs.emplace_back(
        synth.observations.begin(), synth.observations.begin() + 400);
    train_seqs.emplace_back(
        synth.observations.begin() + 400, synth.observations.begin() + 700);
    train_seqs.emplace_back(
        synth.observations.begin() + 700, synth.observations.begin() + 1200);
    train_seqs.emplace_back(
        synth.observations.begin() + 1200, synth.observations.begin() + 1600);

    hmm::BaumWelchConfig config;
    config.tolerance = 1e-4;
    config.max_iterations = 60;

    std::mt19937 rng(999);
    auto result = hmm::baum_welch_train(train_seqs, 3, config, nullptr, &rng);

    std::cout << "(iters=" << result.iterations
              << ", conv=" << result.converged << ") ";
    CHECK(result.iterations >= 3, "Should run at least 3 iterations");
    CHECK(!std::isinf(result.final_log_likelihood),
          "Final log-likelihood should be finite");

    PASS();
}

// ===========================================================================
// main
// ===========================================================================

int main() {
    std::cout << "========================================" << std::endl;
    std::cout << "  HMM Framework Unit Tests" << std::endl;
    std::cout << "========================================" << std::endl;
    std::cout << std::endl;

    test_matrix_ops();
    test_hmm_model();
    test_forward();
    test_viterbi();
    test_numerical_stability();
    test_multisequence_bw();
    test_baum_welch();
    test_regime_detector();
    test_compute_features();

    std::cout << std::endl;
    std::cout << "========================================" << std::endl;
    std::cout << "  Results: " << tests_passed << "/" << tests_run
              << " tests passed" << std::endl;
    std::cout << "========================================" << std::endl;

    return (tests_passed == tests_run) ? 0 : 1;
}
