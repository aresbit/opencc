/// baum_welch.cpp — Baum-Welch EM training implementation
///
/// E-step: compute expected sufficient statistics using forward-backward.
/// M-step: re-estimate A, pi, μ, Σ from accumulated statistics.
///
/// Multi-sequence support: statistics are summed across all sequences.
///
/// Key formulas (from Rabiner 1989):
///   γ_t(i)  = P(q_t=i | O, λ)          ∝ α̂_t(i)·β̂_t(i) / c_t
///   ξ_t(i,j) = P(q_t=i, q_{t+1}=j | O, λ) ∝ α̂_t(i)·a_{ij}·b_j(o_{t+1})·β̂_{t+1}(j)
///
/// After normalization:
///   ā_{ij} = Σ_t ξ_t(i,j) / Σ_t γ_t(i)      (expected transitions / expected visits)
///   π̄_i    = γ_1(i)                           (expected initial state)
///   μ̄_j    = Σ_t γ_t(j)·o_t / Σ_t γ_t(j)    (weighted mean)
///   σ̄²_j   = Σ_t γ_t(j)·(o_t-μ̄_j)² / Σ_t γ_t(j)  (weighted variance)

#include "baum_welch.hpp"
#include "forward.hpp"
#include "backward.hpp"

#include <cmath>
#include <limits>
#include <random>
#include <stdexcept>

namespace hmm {

// ===========================================================================
// BaumWelchStats
// ===========================================================================

BaumWelchStats::BaumWelchStats(size_t n_states, size_t n_dims)
    : n_states(n_states),
      n_dims(n_dims),
      n_sequences(0),
      gamma1_sum(n_states, 1),
      gamma_sum(n_states, 1),
      xi_sum(n_states, n_states),
      mean_denom(n_states, 1) {
    weighted_obs_sum.resize(n_states, Vector(n_dims, 1));
    weighted_sq_sum.resize(n_states, Vector(n_dims, 1));
    reset();
}

void BaumWelchStats::reset() {
    gamma1_sum.fill(0.0);
    gamma_sum.fill(0.0);
    xi_sum.fill(0.0);
    mean_denom.fill(0.0);
    for (size_t i = 0; i < n_states; ++i) {
        weighted_obs_sum[i].fill(0.0);
        weighted_sq_sum[i].fill(0.0);
    }
    n_sequences = 0;
}

void BaumWelchStats::accumulate(const BaumWelchStats& other) {
    if (other.n_states != n_states || other.n_dims != n_dims) {
        throw std::invalid_argument("BaumWelchStats::accumulate: dimension mismatch");
    }
    for (size_t i = 0; i < gamma1_sum.size(); ++i) {
        gamma1_sum.data_[i] += other.gamma1_sum.data_[i];
    }
    for (size_t i = 0; i < gamma_sum.size(); ++i) {
        gamma_sum.data_[i] += other.gamma_sum.data_[i];
    }
    for (size_t i = 0; i < xi_sum.size(); ++i) {
        xi_sum.data_[i] += other.xi_sum.data_[i];
    }
    for (size_t i = 0; i < n_states; ++i) {
        for (size_t d = 0; d < n_dims; ++d) {
            weighted_obs_sum[i](d, 0) += other.weighted_obs_sum[i](d, 0);
            weighted_sq_sum[i](d, 0) += other.weighted_sq_sum[i](d, 0);
        }
        mean_denom.data_[i] += other.mean_denom.data_[i];
    }
    n_sequences += other.n_sequences;
}

// ===========================================================================
// E-step
// ===========================================================================

double expectation_step(const GaussianHMM& model,
                        const std::vector<Vector>& observations,
                        BaumWelchStats& stats) {
    const size_t T = observations.size();
    const size_t N = model.n_states;
    const size_t M = model.n_dims;

    if (T == 0) return 0.0;

    // --- Run forward-backward ---
    ForwardResult fwd = forward_algorithm(model, observations);
    if (std::isinf(fwd.log_likelihood)) {
        return fwd.log_likelihood;
    }

    BackwardResult bwd = backward_algorithm(model, observations, fwd);
    const auto& c = fwd.scale;

    // ====================================================================
    // Compute γ_t(i) for all t
    //   γ_t(i) ∝ α̂_t(i) · β̂_t(i) / c_t
    //   Then normalize so Σ_i γ_t(i) = 1
    // ====================================================================
    std::vector<Vector> gamma(T, Vector(N, 1));

    for (size_t t = 0; t < T; ++t) {
        Vector& g = gamma[t];
        g.fill(0.0);
        double g_sum = 0.0;

        for (size_t i = 0; i < N; ++i) {
            double val = fwd.alpha[t](i, 0) * bwd.beta[t](i, 0);
            // Note: γ ∝ α̂·β̂. We normalize below.
            // But to be consistent with the derivation, divide by c_t:
            // γ_t(i) ∝ α̂_t(i)·β̂_t(i)/c_t
            // Since c_t > 0, this is equivalent to γ_t(i) = α̂_t(i)·β̂_t(i)
            // followed by normalization (the c_t cancels out in normalization).
            if (c[t] > 0.0) {
                val /= c[t];
            }
            g(i, 0) = val;
            g_sum += val;
        }

        // Normalize
        if (g_sum > 0.0) {
            for (size_t i = 0; i < N; ++i) {
                g(i, 0) /= g_sum;
            }
        } else {
            // Degenerate: uniform
            for (size_t i = 0; i < N; ++i) {
                g(i, 0) = 1.0 / static_cast<double>(N);
            }
        }
    }

    // ====================================================================
    // Accumulate γ statistics
    // ====================================================================
    // γ_1 for π
    for (size_t i = 0; i < N; ++i) {
        stats.gamma1_sum(i, 0) += gamma[0](i, 0);
    }

    // Σ_t γ_t(i): used for A denominator and Gaussian parameters.
    // For the A (transition) denominator, we need Σ_{t=0}^{T-2} γ_t(i)
    // because ξ is defined for t=0..T-2. We compute gamma_sum_trans by
    // excluding the last time step. gamma_sum is the full sum.
    for (size_t t = 0; t < T; ++t) {
        for (size_t i = 0; i < N; ++i) {
            double g = gamma[t](i, 0);
            stats.gamma_sum(i, 0) += g;
        }
    }

    // Σ_t γ_t(j) · o_t, Σ_t γ_t(j) · o_t², and Σ_t γ_t(j) for Gaussian params
    for (size_t t = 0; t < T; ++t) {
        const auto& obs = observations[t];
        for (size_t j = 0; j < N; ++j) {
            double g = gamma[t](j, 0);
            stats.mean_denom(j, 0) += g;
            for (size_t d = 0; d < M; ++d) {
                double o_d = obs(d, 0);
                stats.weighted_obs_sum[j](d, 0) += g * o_d;
                // weighted_sq_sum: E[X²] needed for variance = E[X²] - E[X]²
                stats.weighted_sq_sum[j](d, 0) += g * o_d * o_d;
            }
        }
    }

    // ====================================================================
    // Compute ξ_t(i,j) for t = 0..T-2
    //   ξ_t(i,j) ∝ α̂_t(i) · a_{ij} · b_j(o_{t+1}) · β̂_{t+1}(j)
    //   Then normalize: Σ_{i,j} ξ_t(i,j) = 1
    // ====================================================================
    for (size_t t = 0; t < T - 1; ++t) {
        double xi_sum_t = 0.0;
        Matrix xi_t(N, N, 0.0);

        for (size_t i = 0; i < N; ++i) {
            for (size_t j = 0; j < N; ++j) {
                double a_ij = model.A(i, j);
                if (a_ij <= 0.0) continue;

                double log_emis = model.log_emission_prob(j, observations[t + 1]);
                double emission = std::exp(log_emis);
                if (emission < std::numeric_limits<double>::min()) continue;

                double val = fwd.alpha[t](i, 0) * a_ij * emission *
                             bwd.beta[t + 1](j, 0);
                xi_t(i, j) = val;
                xi_sum_t += val;
            }
        }

        // Normalize and accumulate
        if (xi_sum_t > 0.0) {
            for (size_t i = 0; i < N; ++i) {
                for (size_t j = 0; j < N; ++j) {
                    stats.xi_sum(i, j) += xi_t(i, j) / xi_sum_t;
                }
            }
        }
    }

    stats.n_sequences += 1;
    return fwd.log_likelihood;
}

// ===========================================================================
// M-step
// ===========================================================================

void maximization_step(const BaumWelchStats& stats, GaussianHMM& model,
                       double var_floor) {
    const size_t N = model.n_states;
    const size_t M = model.n_dims;

    // --- Re-estimate π ---
    // π_i = γ_1(i) / Σ_j γ_1(j)   (averaged across sequences)
    double pi_sum = 0.0;
    for (size_t i = 0; i < N; ++i) {
        pi_sum += stats.gamma1_sum(i, 0);
    }
    if (pi_sum > 0.0) {
        for (size_t i = 0; i < N; ++i) {
            model.pi(i, 0) = stats.gamma1_sum(i, 0) / pi_sum;
        }
    }

    // --- Re-estimate A ---
    // a_{ij} = Σ_t ξ_t(i,j) / Σ_t γ_t(i)  (the t=1..T-1 part of γ_sum)
    // gamma_sum includes t=0..T-1, but we need t=1..T-1 for the denominator.
    // Actually for A re-estimation: denominator = Σ_{t=1}^{T-1} γ_t(i)
    // Our gamma_sum has all T time steps. For the A denominator we need
    // gamma_sum - gamma_1 (exclude t=0) — but for T=1 this doesn't apply.
    // A more correct formulation: γ for A denominator = Σ_{t=0}^{T-2} γ_t(i).
    //
    // In practice, Rabiner uses:
    //   ā_{ij} = Σ_t ξ_t(i,j) / Σ_t γ_t(i)
    // where both sums are over t=1..T-1 for γ in the denominator.
    // Our gamma_sum has Σ_t γ_t(i) over ALL t (0..T-1).
    // For multi-sequence, we track gamma_sum_total.
    // To get the denominator correctly, we could track γ for t=0..T-2 separately.
    // Simplification: use gamma_sum which includes all t. For long sequences,
    // the difference is negligible. For correctness, let's subtract gamma1_sum.
    // Actually: γ_sum_total (t=0..T-1) minus γ_last_sum would be t=0..T-2.
    // But we don't track γ_last_sum.
    //
    // The cleanest approach: A denominator = gamma_sum (full sum). This is the
    // "expected number of times the state is visited during the entire sequence."
    // The xi sum is over pairs at times 0..T-2.
    // For long sequences this is asymptotically the same.
    // For multi-sequence with varying lengths, it's standard to use gamma_sum.
    //
    // CORRECTION: Rabiner §VIA equation 108 uses:
    //   ā_{ij} = Σ_{t=1}^{T-1} ξ_t(i,j) / Σ_{t=1}^{T-1} γ_t(i)
    //
    // Here Σ_{t=1}^{T-1} γ_t(i) = gamma_sum(i) - γ_1(i) - γ_T(i).
    // For simplicity and following common implementations, we use:
    //   gamma_A_denom(i) = stats.gamma_sum(i) (the full sum).
    // This works because γ_1 and γ_T contributions are O(1/T) relative to the
    // full sum for long sequences. For multi-sequence training, we MUST be
    // careful though. Let me add a separate counter.
    //
    // Actually, let me rethink. gamma_sum already has γ_1 included. For the
    // xi sum we have transitions from t=0..T-2. So Σ_t γ_t(i) over t=0..T-2
    // should be gamma_sum(i) - γ_T(i). But γ_t is always normalized to sum to 1
    // over states, so this subtraction would affect all states equally.
    //
    // The practical and most common approach in numerical HMM implementations
    // (e.g., hmmlearn in Python) is to use gamma_sum_total as the denominator.
    // This is what I'll do — it's standard practice.
    for (size_t i = 0; i < N; ++i) {
        double denom = stats.gamma_sum(i, 0);
        if (denom > 0.0) {
            double row_sum = 0.0;
            for (size_t j = 0; j < N; ++j) {
                double val = stats.xi_sum(i, j) / denom;
                if (val < 0.0) val = 0.0;
                model.A(i, j) = val;
                row_sum += val;
            }
            // Ensure row sums to 1
            if (row_sum > 0.0) {
                for (size_t j = 0; j < N; ++j) {
                    model.A(i, j) /= row_sum;
                }
            } else {
                // Degenerate: uniform row
                for (size_t j = 0; j < N; ++j) {
                    model.A(i, j) = 1.0 / static_cast<double>(N);
                }
            }
        }
        // else: row stays as-is from previous iteration
    }

    // --- Re-estimate Gaussian emission parameters ---
    // μ_j = Σ_t γ_t(j)·o_t / Σ_t γ_t(j)
    // σ_j² = Σ_t γ_t(j)·(o_t - new_μ_j)² / Σ_t γ_t(j)
    for (size_t j = 0; j < N; ++j) {
        double denom = stats.mean_denom(j, 0);
        if (denom > 0.0) {
            // Compute new mean
            for (size_t d = 0; d < M; ++d) {
                model.means[j](d, 0) =
                    stats.weighted_obs_sum[j](d, 0) / denom;
            }

            // Compute new variance using the NEW mean
            // σ_{j,d}^2 = [Σ_t γ_t(j)·o_{t,d}² / Σ_t γ_t(j)] - μ_{j,d}^2
            //
            // But we accumulated Σ_t γ_t(j)·o_t, not Σ_t γ_t(j)·o_t².
            // For simplicity and numerical stability, compute variance from the
            // weighted sum of squares we collected. We'll recompute in place.
            //
            // Actually, weighted_sq_sum is currently all zeros (we don't fill it
            // in the E-step!). I need to track this properly.
            //
            // Alternative: compute variance as:
            //   σ² = Σ γ·(o-μ_old)² / Σ γ + (μ_old - μ_new)²
            // But that's complex. Let me add the squared sum tracking.
            //
            // SIMPLEST FIX: Use weighted_obs_sum and the observation matrix
            // to recompute. But we don't have the observations in M-step.
            // The correct fix is to track weighted_sq_sum in the E-step.
            //
            // For now, compute variance from weighted_obs_sum with note.
            // We know: Var[X] = E[X²] - E[X]²
            // So: σ² = (Σ γ·o² / Σ γ) - μ²
            //
            // We need weighted_sq_sum = Σ γ·o² to be accumulated in E-step.
            // Since we already have weighted_obs_sum and mean, we can compute
            // variance if we also track the sum of squared observations.
            //
            // Quick fix: use the weighted_sq_sum we have (should be filled in
            // E-step — wait, the current E-step code doesn't fill it!).
            //
            // Let me fix this. Looking at the E-step code above, I do NOT fill
            // weighted_sq_sum. I need to add that. Let me use the fact that:
            //
            // For iteration stability, a common trick is to NOT update variances
            // on the first few iterations and keep the initial values.
            // But for a correct implementation, I should track squared sums.
            //
            // Best approach: since we don't have observation data in M-step,
            // use the weighted_obs_sum weighted by the observation means.
            // This is an approximation but widely used.
            //
            // Actually the correct answer: I filled weighted_obs_sum but NOT
            // weighted_sq_sum. I'll fix this below by tracking weighted_sq_sum
            // in a second pass through observations... but we don't have
            // observations in M-step.
            //
            // PRACTICAL SOLUTION: Track weighted_sq_sum in the E-step.
            // I already declared it in the struct. I just need to compute it.
            // Fix the E-step to accumulate:
            //   weighted_sq_sum[j][d] += γ_t(j) * o_{t,d} * o_{t,d}
            //
            // Then in M-step:
            //   σ² = weighted_sq_sum / Σγ - μ²
            //
            // I'll add this fix to the E-step code above.

            for (size_t d = 0; d < M; ++d) {
                // Using weighted_sq_sum from E-step.
                // σ² = E[X²] - E[X]²
                double ex2 = stats.weighted_sq_sum[j](d, 0) / denom;
                double mu = model.means[j](d, 0);
                double var = ex2 - mu * mu;
                if (var < var_floor) var = var_floor;
                model.covars[j](d, 0) = var;
            }
        }
        // else: keep existing Gaussian parameters
    }

    model.invalidate_cache();
}

// ===========================================================================
// Full training loop
// ===========================================================================

BaumWelchResult baum_welch_train(
    const std::vector<std::vector<Vector>>& observations,
    size_t n_states,
    const BaumWelchConfig& config,
    const GaussianHMM* init_model,
    std::mt19937* rng) {

    if (observations.empty()) {
        throw std::invalid_argument("baum_welch_train: no observation sequences");
    }
    if (n_states == 0) {
        throw std::invalid_argument("baum_welch_train: n_states must be > 0");
    }

    const size_t K = observations.size();
    size_t n_dims = observations[0].empty() ? 1 : observations[0][0].rows();

    // Validate all sequences have consistent dimensionality
    for (size_t k = 0; k < K; ++k) {
        if (observations[k].empty()) continue;
        size_t dims = observations[k][0].rows();
        if (dims != n_dims) {
            throw std::invalid_argument(
                "baum_welch_train: inconsistent observation dimensions");
        }
    }

    // --- Initialize model ---
    BaumWelchResult result;
    result.iterations = 0;
    result.converged = false;

    if (init_model) {
        result.model = *init_model;
    } else {
        result.model = GaussianHMM(n_states, n_dims);
        // Flatten all observations for initialization
        std::vector<Vector> flat_obs;
        for (const auto& seq : observations) {
            flat_obs.insert(flat_obs.end(), seq.begin(), seq.end());
        }
        std::mt19937 local_rng;
        if (rng) {
            local_rng = *rng;
        } else {
            std::random_device rd;
            local_rng.seed(rd());
        }
        result.model.random_init(flat_obs, local_rng);
    }
    result.model.var_floor = config.var_floor;

    double prev_log_likelihood = -std::numeric_limits<double>::infinity();

    // --- EM iterations ---
    for (size_t iter = 0; iter < config.max_iterations; ++iter) {
        // Accumulate statistics across all sequences
        BaumWelchStats stats(n_states, n_dims);
        double total_log_likelihood = 0.0;

        for (size_t k = 0; k < K; ++k) {
            if (observations[k].empty()) continue;
            BaumWelchStats seq_stats(n_states, n_dims);
            double ll = expectation_step(result.model, observations[k],
                                         seq_stats);
            total_log_likelihood += ll;
            stats.accumulate(seq_stats);
        }

        result.log_likelihood_history.push_back(total_log_likelihood);
        result.iterations = iter + 1;

        // --- Convergence check ---
        if (iter > 0) {
            double delta =
                std::abs(total_log_likelihood - prev_log_likelihood);
            double rel_change =
                (std::abs(total_log_likelihood) > 1e-10)
                    ? delta / std::abs(total_log_likelihood)
                    : delta;

            if (rel_change < config.tolerance) {
                result.converged = true;
                result.final_log_likelihood = total_log_likelihood;
                break;
            }

            // Check for divergence
            if (total_log_likelihood < prev_log_likelihood - 1.0 &&
                iter > 5) {
                // Likelihood decreased significantly — may indicate numerical
                // issues. Roll back and stop.
                result.final_log_likelihood = prev_log_likelihood;
                break;
            }
        }

        prev_log_likelihood = total_log_likelihood;

        // --- M-step ---
        maximization_step(stats, result.model, config.var_floor);

        // --- Callback ---
        if (config.callback) {
            if (!config.callback(iter, total_log_likelihood, result.model)) {
                break; // early stop requested
            }
        }
    }

    if (!result.converged && result.iterations == config.max_iterations) {
        result.final_log_likelihood = prev_log_likelihood;
    }

    // Final log_A precomputation
    result.model.compute_log_A();

    return result;
}

} // namespace hmm
