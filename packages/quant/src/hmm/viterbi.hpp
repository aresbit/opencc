#pragma once
/// viterbi.hpp — Log-space Viterbi Decoder for HMMs
///
/// Finds the single most likely sequence of hidden states given observations.
/// All computations in log-space to prevent underflow.
///
/// Reference: Rabiner (1989) Proc. IEEE 77(2), §V "Implementation of the
/// Viterbi Algorithm"

#include "hmm_model.hpp"

#include <cstddef>
#include <vector>

namespace hmm {

/// Result of Viterbi decoding
struct ViterbiResult {
    /// Most likely state sequence: length T, each entry is state_id [0, N)
    std::vector<size_t> path;

    /// Log probability of the best path: log P(Q*, O | λ)
    double log_probability;
};

/// Run the Viterbi algorithm in log-space.
///
/// @param model  The HMM (log_A must be precomputed via compute_log_A())
/// @param observations  Sequence of observation vectors
/// @return ViterbiResult with best state path and log probability
ViterbiResult viterbi_decode(const GaussianHMM& model,
                             const std::vector<Vector>& observations);

} // namespace hmm
