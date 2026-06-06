#pragma once
/// baum_welch.hpp — Baum-Welch EM Algorithm for Gaussian HMMs
///
/// Unsupervised parameter estimation using Expectation-Maximization.
/// Handles multiple observation sequences of different lengths.
///
/// References:
///   Rabiner (1989) "A Tutorial on Hidden Markov Models" — Proc. IEEE 77(2), §VIA
///   Bilmes (1998) "A Gentle Tutorial of the EM Algorithm" — §4
///   Jurafsky & Martin (2026) "Speech and Language Processing" — Appendix A.5

#include "hmm_model.hpp"

#include <cstddef>
#include <functional>
#include <vector>

namespace hmm {

/// Accumulated sufficient statistics for one Baum-Welch iteration.
/// Used to aggregate across multiple observation sequences.
struct BaumWelchStats {
    size_t n_states;
    size_t n_dims;
    size_t n_sequences;

    /// Accumulated γ_1 for π re-estimation: size N
    Vector gamma1_sum;

    /// Accumulated γ for A denominator: size N
    Vector gamma_sum;

    /// Accumulated ξ for A numerator: size N×N
    Matrix xi_sum;

    /// Accumulated γ * observation for mean numerator: N vectors of size M
    std::vector<Vector> weighted_obs_sum;

    /// Accumulated γ for mean denominator: size N
    Vector mean_denom;

    /// Accumulated γ * (obs - μ)^2 for covariance numerator: N vectors of size M
    std::vector<Vector> weighted_sq_sum;

    BaumWelchStats(size_t n_states, size_t n_dims);
    void reset();
    void accumulate(const BaumWelchStats& other);
};

/// Training configuration
struct BaumWelchConfig {
    /// Convergence threshold: stop when |ΔlogL| / |logL| < tol
    double tolerance = 1e-6;

    /// Maximum EM iterations
    size_t max_iterations = 200;

    /// Minimum variance floor (applied after each M-step)
    double var_floor = 1e-6;

    /// Callback invoked after each iteration: fn(iteration, log_likelihood, model)
    /// Return false to trigger early stopping.
    std::function<bool(size_t, double, const GaussianHMM&)> callback;
};

/// Result of Baum-Welch training
struct BaumWelchResult {
    /// Trained HMM
    GaussianHMM model;

    /// Log-likelihood history (one entry per iteration)
    std::vector<double> log_likelihood_history;

    /// Number of iterations performed
    size_t iterations;

    /// Whether convergence was achieved
    bool converged;

    /// Final log-likelihood
    double final_log_likelihood;
};

/// E-step: compute γ and ξ for a single observation sequence.
/// Returns the accumulated statistics and the sequence log-likelihood.
///
/// @param model  Current HMM parameters
/// @param observations  Single observation sequence
/// @param stats  [out] Sufficient statistics for this sequence
/// @return log-likelihood of this sequence under the model
double expectation_step(const GaussianHMM& model,
                        const std::vector<Vector>& observations,
                        BaumWelchStats& stats);

/// M-step: re-estimate model parameters from accumulated statistics.
///
/// @param stats  Accumulated statistics from all sequences
/// @param model  [in/out] Model to update
/// @param var_floor  Minimum variance to enforce
void maximization_step(const BaumWelchStats& stats, GaussianHMM& model,
                       double var_floor);

/// Full Baum-Welch training on multiple observation sequences.
///
/// @param observations  Vector of observation sequences (each sequence is a vector of Vectors)
/// @param n_states  Number of hidden states
/// @param config  Training configuration
/// @param init_model  [optional] Initial model parameters. If nullptr, use random_init.
/// @param rng  Random number generator for initialization
/// @return BaumWelchResult with trained model and diagnostics
BaumWelchResult baum_welch_train(
    const std::vector<std::vector<Vector>>& observations,
    size_t n_states,
    const BaumWelchConfig& config = BaumWelchConfig{},
    const GaussianHMM* init_model = nullptr,
    std::mt19937* rng = nullptr);

} // namespace hmm
