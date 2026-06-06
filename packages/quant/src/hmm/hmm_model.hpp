#pragma once
/// hmm_model.hpp — Hidden Markov Model with Gaussian emissions
///
/// Designed for financial regime detection:
///   - N hidden states (e.g., bull / sideways / bear)
///   - M-dimensional continuous Gaussian observations (returns, volume, spread, etc.)
///   - Diagonal covariance for computational efficiency
///
/// References:
///   Rabiner (1989) "A Tutorial on Hidden Markov Models" — Proc. IEEE 77(2)
///   Jurafsky & Martin (2026) "Speech and Language Processing" — Appendix A
///   Bishop (2006) "Pattern Recognition and ML" — §13.2

#include "matrix.hpp"

#include <cmath>
#include <random>
#include <string>
#include <vector>

namespace hmm {

// ---------------------------------------------------------------------------
// GaussianHMM — full parameter set for a continuous-density HMM
// ---------------------------------------------------------------------------
struct GaussianHMM {
    // --- Dimensions ---
    size_t n_states;   // N: number of hidden states
    size_t n_dims;     // M: observation vector dimension

    // --- Parameters ---
    /// Initial state distribution π: size (N × 1), Σ_i π_i = 1
    Vector pi;

    /// Transition matrix A: size (N × N)
    /// A(i,j) = P(q_{t+1}=j | q_t=i), rows sum to 1
    Matrix A;

    /// Emission means: N vectors, each M-dimensional
    /// means[i] is the mean vector for state i
    std::vector<Vector> means;

    /// Diagonal emission covariances: N vectors, each M-dimensional
    /// covars[i][d] = variance of dimension d in state i
    std::vector<Vector> covars;

    // --- Computed helpers ---
    /// log(A) precomputed for log-space Viterbi
    Matrix log_A;
    bool log_A_valid = false;

    /// Minimum variance floor to prevent degenerate Gaussians
    double var_floor = 1e-6;

    // --- Conway ---
    GaussianHMM() : n_states(0), n_dims(0) {}

    GaussianHMM(size_t n_states, size_t n_dims);

    /// Invalidate cached log_A (call after modifying A)
    void invalidate_cache() { log_A_valid = false; }

    /// Precompute log(A) for log-space operations
    void compute_log_A();

    // --- Gaussian emission ---
    /// Compute log emission probability: log b_j(o_t) = log N(o_t | μ_j, Σ_j)
    /// Returns log probability (natural log).
    double log_emission_prob(size_t state, const Vector& observation) const;

    /// Compute emission probabilities for ALL states given observation
    /// Returns Vector of size N with b_j(o_t) in linear space
    Vector emission_probs(const Vector& observation) const;

    // --- Initialization ---
    /// Randomly initialize parameters given the dataset statistics
    void random_init(const std::vector<Vector>& observations, std::mt19937& rng);

    /// K-means-style initialization: cluster observations into N states,
    /// then estimate means/covars from cluster assignments.
    void kmeans_init(const std::vector<Vector>& observations,
                     size_t max_iter = 20, std::mt19937* rng = nullptr);

    // --- Validation ---
    /// Check that A rows sum to 1 and are non-negative
    bool is_valid() const;

    /// Pretty-print parameters
    std::string to_string() const;
};

// ===================================================================
// Inline implementations
// ===================================================================

inline GaussianHMM::GaussianHMM(size_t n_states, size_t n_dims)
    : n_states(n_states), n_dims(n_dims),
      pi(n_states, 1),
      A(n_states, n_states),
      log_A(n_states, n_states) {
    // Default: uniform initial distribution
    pi.fill(1.0 / static_cast<double>(n_states));
    // Default: uniform transition (each row sums to 1)
    for (size_t i = 0; i < n_states; ++i) {
        for (size_t j = 0; j < n_states; ++j) {
            A(i, j) = 1.0 / static_cast<double>(n_states);
        }
    }
    means.resize(n_states, Vector(n_dims, 1));
    covars.resize(n_states, Vector(n_dims, 1));
    for (auto& cv : covars) cv.fill(1.0);
    compute_log_A();
}

inline void GaussianHMM::compute_log_A() {
    log_A = Matrix(n_states, n_states);
    for (size_t i = 0; i < n_states; ++i) {
        for (size_t j = 0; j < n_states; ++j) {
            double v = A(i, j);
            if (v <= 0.0) {
                log_A(i, j) = -1e10; // log(0) → -inf approximation
            } else {
                log_A(i, j) = std::log(v);
            }
        }
    }
    log_A_valid = true;
}

inline double GaussianHMM::log_emission_prob(size_t state,
                                              const Vector& observation) const {
    // log N(x | μ, Σ) = -M/2·log(2π) - ½·Σ_d log(σ²_d) - ½·Σ_d (x_d-μ_d)²/σ²_d
    // Diagonal covariance assumption.
    const auto& mu = means[state];
    const auto& sig2 = covars[state];

    double log_prob = -0.5 * static_cast<double>(n_dims) *
                      std::log(2.0 * M_PI);

    double mahalanobis_sq = 0.0; // squared Mahalanobis distance for diagonal Σ
    for (size_t d = 0; d < n_dims; ++d) {
        double s2 = sig2(d, 0);
        if (s2 < var_floor) s2 = var_floor;
        log_prob -= 0.5 * std::log(s2);
        double diff = observation(d, 0) - mu(d, 0);
        mahalanobis_sq += (diff * diff) / s2;
    }
    log_prob -= 0.5 * mahalanobis_sq;

    return log_prob;
}

inline Vector GaussianHMM::emission_probs(const Vector& observation) const {
    Vector probs(n_states, 1);
    // Compute in log-space first, then exp and normalize
    // (or keep in log-space if caller needs that)
    double max_log = -1e100;
    for (size_t j = 0; j < n_states; ++j) {
        double lp = log_emission_prob(j, observation);
        probs(j, 0) = lp;
        if (lp > max_log) max_log = lp;
    }
    // Shift and exp for numerical stability
    double sum = 0.0;
    for (size_t j = 0; j < n_states; ++j) {
        probs(j, 0) = std::exp(probs(j, 0) - max_log);
        sum += probs(j, 0);
    }
    if (sum > 0.0) {
        for (size_t j = 0; j < n_states; ++j) {
            probs(j, 0) /= sum;
        }
    }
    return probs;
}

inline void GaussianHMM::random_init(
    const std::vector<Vector>& observations, std::mt19937& rng) {

    if (observations.empty()) return;

    // Compute global mean and variance of observations for sensible init
    Vector global_mean(n_dims, 1);
    global_mean.fill(0.0);
    for (const auto& obs : observations) {
        for (size_t d = 0; d < n_dims; ++d) {
            global_mean(d, 0) += obs(d, 0);
        }
    }
    for (size_t d = 0; d < n_dims; ++d) {
        global_mean(d, 0) /= static_cast<double>(observations.size());
    }

    Vector global_var(n_dims, 1);
    global_var.fill(0.0);
    for (const auto& obs : observations) {
        for (size_t d = 0; d < n_dims; ++d) {
            double diff = obs(d, 0) - global_mean(d, 0);
            global_var(d, 0) += diff * diff;
        }
    }
    for (size_t d = 0; d < n_dims; ++d) {
        global_var(d, 0) /= static_cast<double>(observations.size());
        if (global_var(d, 0) < var_floor) global_var(d, 0) = var_floor;
    }

    // Randomize initial distribution
    {
        std::uniform_real_distribution<double> dist(0.0, 1.0);
        double sum = 0.0;
        for (size_t i = 0; i < n_states; ++i) {
            pi(i, 0) = dist(rng) + 0.1;
            sum += pi(i, 0);
        }
        for (size_t i = 0; i < n_states; ++i) {
            pi(i, 0) /= sum;
        }
    }

    // Randomize transition matrix (stochastic rows)
    {
        std::uniform_real_distribution<double> dist(0.0, 1.0);
        for (size_t i = 0; i < n_states; ++i) {
            double row_sum = 0.0;
            // Higher self-transition probability (sticky states)
            for (size_t j = 0; j < n_states; ++j) {
                A(i, j) = (i == j) ? (dist(rng) * 2.0 + 2.0)
                                   : (dist(rng) * 0.5 + 0.1);
                row_sum += A(i, j);
            }
            for (size_t j = 0; j < n_states; ++j) {
                A(i, j) /= row_sum;
            }
        }
    }

    // Randomize means (perturb global mean)
    {
        std::normal_distribution<double> dist(0.0, 1.0);
        for (size_t i = 0; i < n_states; ++i) {
            means[i] = Vector(n_dims, 1);
            for (size_t d = 0; d < n_dims; ++d) {
                means[i](d, 0) = global_mean(d, 0) +
                                 dist(rng) * std::sqrt(global_var(d, 0));
            }
        }
    }

    // Initialize covariances from global variance
    for (size_t i = 0; i < n_states; ++i) {
        covars[i] = Vector(n_dims, 1);
        for (size_t d = 0; d < n_dims; ++d) {
            covars[i](d, 0) = global_var(d, 0);
        }
    }

    compute_log_A();
}

inline bool GaussianHMM::is_valid() const {
    // Check A rows sum to ~1
    for (size_t i = 0; i < n_states; ++i) {
        double row_sum = 0.0;
        for (size_t j = 0; j < n_states; ++j) {
            if (A(i, j) < -1e-12) return false; // negative probability
            row_sum += A(i, j);
        }
        if (std::abs(row_sum - 1.0) > 1e-9) return false;
    }
    // Check pi sums to ~1
    double pi_sum = 0.0;
    for (size_t i = 0; i < n_states; ++i) {
        if (pi(i, 0) < -1e-12) return false;
        pi_sum += pi(i, 0);
    }
    if (std::abs(pi_sum - 1.0) > 1e-9) return false;

    // Check covariances are positive
    for (size_t i = 0; i < n_states; ++i) {
        for (size_t d = 0; d < n_dims; ++d) {
            if (covars[i](d, 0) < var_floor * 0.5) return false;
        }
    }
    return true;
}

inline std::string GaussianHMM::to_string() const {
    std::ostringstream oss;
    oss << std::fixed << std::setprecision(6);
    oss << "GaussianHMM(N=" << n_states << ", M=" << n_dims << ")\n";
    oss << "pi (initial):\n" << hmm::to_string(pi);
    oss << "A (transition):\n" << hmm::to_string(A);
    oss << "Emission parameters:\n";
    for (size_t i = 0; i < n_states; ++i) {
        oss << "  State " << i << ":\n";
        oss << "    mean: " << hmm::to_string(transpose(means[i]));
        oss << "    var:  " << hmm::to_string(transpose(covars[i]));
    }
    return oss.str();
}

} // namespace hmm
