/// backward.cpp — Scaled Backward Algorithm implementation
///
/// Uses the same scaling coefficients c_t from the forward pass.
///
/// Scaling scheme (our convention):
///   β̂_T(i) = c_T  (final forward scale coefficient)
///   β̂_t(i) = c_t · Σ_j a_{ij} · b_j(o_{t+1}) · β̂_{t+1}(j)
///
/// Then: β̂_t(i) = (∏_{s=t}^T c_s) · β_t(i) (true unscaled)
///
/// Posterior: γ_t(i) ∝ α̂_t(i) · β̂_t(i) / c_t
/// Then normalize so Σ_i γ_t(i) = 1.
///
/// Reference: Rabiner (1989) Proc. IEEE 77(2), §IV

#include "backward.hpp"

#include <cmath>
#include <limits>
#include <stdexcept>

namespace hmm {

BackwardResult backward_algorithm(const GaussianHMM& model,
                                  const std::vector<Vector>& observations,
                                  const ForwardResult& forward_result) {
    if (observations.empty()) {
        throw std::invalid_argument("backward_algorithm: empty observation sequence");
    }
    if (forward_result.scale.size() != observations.size()) {
        throw std::invalid_argument(
            "backward_algorithm: forward scale size mismatch with observations");
    }

    const size_t T = observations.size();
    const size_t N = model.n_states;
    const auto& c = forward_result.scale;

    BackwardResult result;
    result.beta.resize(T, Vector(N, 1));

    // ========================================================================
    // Step 1: Initialization (t = T-1)
    //   β̂_T(i) = c_T  for all i
    // ========================================================================
    for (size_t i = 0; i < N; ++i) {
        result.beta[T - 1](i, 0) = c[T - 1];
    }

    // ========================================================================
    // Step 2: Backward induction (t = T-2 down to 0)
    //   β̂_t(i) = c_t · Σ_j a_{ij} · b_j(o_{t+1}) · β̂_{t+1}(j)
    // ========================================================================
    for (size_t t_plus_1 = T - 1; t_plus_1 >= 1; --t_plus_1) {
        size_t t = t_plus_1 - 1; // t is the index we're computing

        Vector beta_t(N, 1);
        beta_t.fill(0.0);

        const auto& beta_next = result.beta[t_plus_1];

        for (size_t i = 0; i < N; ++i) {
            double sum = 0.0;
            for (size_t j = 0; j < N; ++j) {
                double a_ij = model.A(i, j);
                if (a_ij <= 0.0) continue;

                double log_emission =
                    model.log_emission_prob(j, observations[t_plus_1]);
                double emission = std::exp(log_emission);
                if (emission < std::numeric_limits<double>::min()) continue;

                sum += a_ij * emission * beta_next(j, 0);
            }
            beta_t(i, 0) = sum;
        }

        // Scale by c_t (the scale coefficient at time t)
        for (size_t i = 0; i < N; ++i) {
            beta_t(i, 0) *= c[t];
        }

        result.beta[t] = beta_t;
    }

    return result;
}

} // namespace hmm
