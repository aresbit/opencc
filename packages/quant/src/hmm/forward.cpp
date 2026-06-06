/// forward.cpp — Scaled Forward Algorithm implementation
///
/// Rabiner (1989) "A Tutorial on Hidden Markov Models" — §IV Scaling
///
/// The key insight: α values become exponentially small as T grows.
/// Scaling prevents underflow by normalizing α at each time step.
/// The scale factors are then used to recover the true log-likelihood.

#include "forward.hpp"

#include <cmath>
#include <limits>
#include <stdexcept>

namespace hmm {

ForwardResult forward_algorithm(const GaussianHMM& model,
                                const std::vector<Vector>& observations) {
    if (observations.empty()) {
        throw std::invalid_argument("forward_algorithm: empty observation sequence");
    }

    const size_t T = observations.size();
    const size_t N = model.n_states;

    ForwardResult result;
    result.alpha.reserve(T);
    result.scale.reserve(T);
    result.log_likelihood = 0.0;

    // ========================================================================
    // Step 1: Initialization (t=0)
    //   α̅_1(j) = π_j · b_j(o_1)
    //   c_1 = 1 / Σ_j α̅_1(j)
    //   α̂_1(j) = c_1 · α̅_1(j)   →   scaled to sum to 1
    // ========================================================================
    Vector alpha_t(N, 1);
    alpha_t.fill(0.0);

    for (size_t j = 0; j < N; ++j) {
        double log_emission = model.log_emission_prob(j, observations[0]);
        // α_1(j) = π_j · b_j(o_1)
        // In log-space: log α_1(j) = log(π_j) + log(b_j)
        // But we need linear values for scaling, so compute directly:
        double pi_j = model.pi(j, 0);
        if (pi_j <= 0.0) {
            alpha_t(j, 0) = 0.0;
            continue;
        }
        alpha_t(j, 0) = pi_j * std::exp(log_emission);
    }

    // Compute scaling coefficient
    double alpha_sum = 0.0;
    for (size_t j = 0; j < N; ++j) {
        alpha_sum += alpha_t(j, 0);
    }

    if (alpha_sum < std::numeric_limits<double>::min()) {
        // Numerical collapse: all probabilities essentially zero.
        // Return degenerate result with -inf log-likelihood.
        result.log_likelihood = -std::numeric_limits<double>::infinity();
        return result;
    }

    double c_t = 1.0 / alpha_sum;
    for (size_t j = 0; j < N; ++j) {
        alpha_t(j, 0) *= c_t;
    }

    result.alpha.push_back(alpha_t);
    result.scale.push_back(c_t);
    result.log_likelihood -= std::log(c_t); // accumulate -log(c_t)

    // ========================================================================
    // Step 2: Induction (t = 1 .. T-1)
    //   α̅_t(j) = [Σ_i α̂_{t-1}(i) · a_{ij}] · b_j(o_t)
    //   c_t = 1 / Σ_j α̅_t(j)
    //   α̂_t(j) = c_t · α̅_t(j)
    // ========================================================================
    for (size_t t = 1; t < T; ++t) {
        Vector alpha_next(N, 1);
        alpha_next.fill(0.0);

        const auto& alpha_prev = result.alpha[t - 1];

        for (size_t j = 0; j < N; ++j) {
            double log_emission = model.log_emission_prob(j, observations[t]);
            double emission = std::exp(log_emission);
            if (emission < std::numeric_limits<double>::min()) {
                alpha_next(j, 0) = 0.0;
                continue;
            }

            // Σ_i α̂_{t-1}(i) · a_{ij}
            double transition_sum = 0.0;
            for (size_t i = 0; i < N; ++i) {
                transition_sum += alpha_prev(i, 0) * model.A(i, j);
            }

            alpha_next(j, 0) = transition_sum * emission;
        }

        // Scale
        alpha_sum = 0.0;
        for (size_t j = 0; j < N; ++j) {
            alpha_sum += alpha_next(j, 0);
        }

        if (alpha_sum < std::numeric_limits<double>::min()) {
            // Numerical collapse at time t
            result.log_likelihood = -std::numeric_limits<double>::infinity();
            // Fill remaining with degenerate values
            while (result.alpha.size() < T) {
                Vector degenerate(N, 1);
                degenerate.fill(1.0 / static_cast<double>(N));
                result.alpha.push_back(degenerate);
                result.scale.push_back(1.0);
            }
            return result;
        }

        c_t = 1.0 / alpha_sum;
        for (size_t j = 0; j < N; ++j) {
            alpha_next(j, 0) *= c_t;
        }

        result.alpha.push_back(alpha_next);
        result.scale.push_back(c_t);
        result.log_likelihood -= std::log(c_t);
    }

    return result;
}

} // namespace hmm
