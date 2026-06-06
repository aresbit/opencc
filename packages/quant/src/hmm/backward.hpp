#pragma once
/// backward.hpp — Scaled Backward Algorithm for HMMs
///
/// Computes backward variables β_t(i) = P(o_{t+1},...,o_T | q_t=i, λ)
/// using the same scaling coefficients from the forward pass.
///
/// Reference: Rabiner (1989) Proc. IEEE 77(2), §IV "Scaling"

#include "forward.hpp"

#include <vector>

namespace hmm {

/// Result of the scaled backward algorithm
struct BackwardResult {
    /// Scaled backward variables β̂_t(i): size (T × N)
    /// β̂_t(i) = c_t·c_{t+1}·...·c_T · P(o_{t+1},...,o_T | q_t=i, λ)
    std::vector<Vector> beta;
};

/// Run the scaled backward algorithm.
///
/// @param model  The HMM
/// @param observations  Observation sequence (length T)
/// @param forward_result  Previously computed forward result (for scale coeffs)
/// @return BackwardResult with beta matrix
///
/// NOTE: Do NOT use the scale coefficients from forward_result directly as
/// multiplicative factors on beta_init. The scaled backward algorithm uses the
/// same c_t values to normalize each step. The recurrence is:
///   β̂_t(i) = c_t · Σ_j a_{ij} · b_j(o_{t+1}) · β̂_{t+1}(j)
/// where β̂_T(i) = c_T (the final forward scale coefficient).
BackwardResult backward_algorithm(const GaussianHMM& model,
                                  const std::vector<Vector>& observations,
                                  const ForwardResult& forward_result);

} // namespace hmm
