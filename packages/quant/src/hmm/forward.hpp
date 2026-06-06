#pragma once
/// forward.hpp — Scaled Forward Algorithm for HMMs
///
/// Computes P(O|λ) — the likelihood of an observation sequence given the model.
/// Uses Rabiner (1989) scaling to prevent numerical underflow for long sequences.
///
/// Reference: Rabiner (1989) Proc. IEEE 77(2), §IV "Scaling"

#include "hmm_model.hpp"

#include <vector>

namespace hmm {

/// Result of the scaled forward algorithm
struct ForwardResult {
    /// Scaled forward variables α̂_t(i): size (T × N)
    /// α̂_t(i) = c_1·c_2·...·c_t · P(o_1,...,o_t, q_t=i | λ)
    /// Each row sums to 1 by construction.
    std::vector<Vector> alpha;

    /// Scaling coefficients c_t, size T
    /// c_t normalizes α at time t so Σ_i α̂_t(i) = 1
    std::vector<double> scale;

    /// Log-likelihood: log P(O | λ) = -Σ_{t=1}^T log(c_t)
    double log_likelihood;
};

/// Run the scaled forward algorithm on a single observation sequence.
///
/// @param model  The HMM (must have valid A, pi, means, covars)
/// @param observations  Sequence of observation vectors (length T, each M-dim)
/// @return ForwardResult with alpha matrix, scale coefficients, log-likelihood
ForwardResult forward_algorithm(const GaussianHMM& model,
                                const std::vector<Vector>& observations);

} // namespace hmm
