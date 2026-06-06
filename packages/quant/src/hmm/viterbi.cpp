/// viterbi.cpp — Log-space Viterbi Decoder implementation
///
/// The Viterbi algorithm computes:
///   Q* = argmax_Q P(Q | O, λ) = argmax_Q P(Q, O | λ)
///
/// In log-space:
///   δ_t(j) = max_i [δ_{t-1}(i) + log a_{ij}] + log b_j(o_t)
///   ψ_t(j) = argmax_i [δ_{t-1}(i) + log a_{ij}]
///
/// At termination:
///   q*_T = argmax_j δ_T(j)
///   log P* = max_j δ_T(j)
///   q*_t = ψ_{t+1}(q*_{t+1})  (traceback)

#include "viterbi.hpp"

#include <cmath>
#include <limits>
#include <stdexcept>

namespace hmm {

ViterbiResult viterbi_decode(const GaussianHMM& model,
                             const std::vector<Vector>& observations) {
    if (observations.empty()) {
        throw std::invalid_argument("viterbi_decode: empty observation sequence");
    }
    if (!model.log_A_valid) {
        throw std::invalid_argument(
            "viterbi_decode: log_A not computed — call model.compute_log_A() first");
    }

    const size_t T = observations.size();
    const size_t N = model.n_states;

    // δ[t][j] = log probability of best path ending in state j at time t
    // ψ[t][j] = best predecessor state
    std::vector<Vector> delta(T, Vector(N, 1));
    std::vector<std::vector<size_t>> psi(T, std::vector<size_t>(N, 0));

    // ========================================================================
    // Initialization (t=0)
    //   δ_1(j) = log π_j + log b_j(o_1)
    //   ψ_1(j) = 0 (no predecessor)
    // ========================================================================
    for (size_t j = 0; j < N; ++j) {
        double log_pi = (model.pi(j, 0) > 0.0)
                            ? std::log(model.pi(j, 0))
                            : -std::numeric_limits<double>::infinity();
        double log_emis = model.log_emission_prob(j, observations[0]);
        delta[0](j, 0) = log_pi + log_emis;
        psi[0][j] = 0;
    }

    // ========================================================================
    // Recursion (t = 1 .. T-1)
    //   δ_t(j) = max_i [δ_{t-1}(i) + log a_{ij}] + log b_j(o_t)
    //   ψ_t(j) = argmax_i [δ_{t-1}(i) + log a_{ij}]
    // ========================================================================
    for (size_t t = 1; t < T; ++t) {
        for (size_t j = 0; j < N; ++j) {
            double log_emis = model.log_emission_prob(j, observations[t]);

            double best_val = -std::numeric_limits<double>::infinity();
            size_t best_i = 0;

            for (size_t i = 0; i < N; ++i) {
                double val = delta[t - 1](i, 0) + model.log_A(i, j);
                if (val > best_val) {
                    best_val = val;
                    best_i = i;
                }
            }

            delta[t](j, 0) = best_val + log_emis;
            psi[t][j] = best_i;
        }
    }

    // ========================================================================
    // Termination
    //   P* = max_j δ_T(j)
    //   q*_T = argmax_j δ_T(j)
    // ========================================================================
    ViterbiResult result;
    result.path.resize(T);

    double best_final = -std::numeric_limits<double>::infinity();
    size_t best_final_state = 0;
    for (size_t j = 0; j < N; ++j) {
        if (delta[T - 1](j, 0) > best_final) {
            best_final = delta[T - 1](j, 0);
            best_final_state = j;
        }
    }
    result.log_probability = best_final;
    result.path[T - 1] = best_final_state;

    // ========================================================================
    // Backtrack
    //   q*_t = ψ_{t+1}(q*_{t+1})
    // ========================================================================
    for (size_t t = T - 1; t >= 1; --t) {
        result.path[t - 1] = psi[t][result.path[t]];
    }

    return result;
}

} // namespace hmm
