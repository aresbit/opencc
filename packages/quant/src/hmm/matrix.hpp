#pragma once
/// matrix.hpp — Lightweight Matrix/Vector class for HMM computations
///
/// Design: flat std::vector<double> storage for cache locality.
/// All HMM matrices are small (N states ≤ 20 typically), so naive O(N^3)
/// multiply is acceptable — no need for BLAS dependencies.
///
/// Reference: Rabiner (1989) "A Tutorial on Hidden Markov Models" §III

#include <cmath>
#include <cstddef>
#include <iomanip>
#include <iostream>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace hmm {

// ---------------------------------------------------------------------------
// Matrix — 2D matrix stored row-major in a flat vector
// ---------------------------------------------------------------------------
struct Matrix {
    size_t rows_;
    size_t cols_;
    std::vector<double> data_;

    Matrix() : rows_(0), cols_(0) {}

    Matrix(size_t rows, size_t cols, double init = 0.0)
        : rows_(rows), cols_(cols), data_(rows * cols, init) {}

    Matrix(size_t rows, size_t cols, std::vector<double> data)
        : rows_(rows), cols_(cols), data_(std::move(data)) {
        if (data_.size() != rows_ * cols_) {
            throw std::invalid_argument("Matrix data size mismatch");
        }
    }

    // Accessors
    double& operator()(size_t i, size_t j) {
        return data_[i * cols_ + j];
    }
    const double& operator()(size_t i, size_t j) const {
        return data_[i * cols_ + j];
    }

    size_t rows() const { return rows_; }
    size_t cols() const { return cols_; }
    size_t size() const { return rows_ * cols_; }

    const double* raw_data() const { return data_.data(); }
    double* raw_data() { return data_.data(); }

    void fill(double val) {
        std::fill(data_.begin(), data_.end(), val);
    }

    // Extract a single row as a new (1 × cols) Matrix
    Matrix row(size_t i) const {
        Matrix r(1, cols_);
        std::copy(data_.begin() + static_cast<long>(i * cols_),
                  data_.begin() + static_cast<long>((i + 1) * cols_),
                  r.data_.begin());
        return r;
    }

    // Set a row from a vector (size must match cols_)
    void set_row(size_t i, const std::vector<double>& vals) {
        if (vals.size() != cols_) {
            throw std::invalid_argument("set_row: vector size != cols");
        }
        std::copy(vals.begin(), vals.end(),
                  data_.begin() + static_cast<long>(i * cols_));
    }

    // Equality (for testing)
    bool operator==(const Matrix& other) const {
        return rows_ == other.rows_ && cols_ == other.cols_ &&
               data_ == other.data_;
    }
};

// ---------------------------------------------------------------------------
// Vector — convenience alias: single-column Matrix
// ---------------------------------------------------------------------------
using Vector = Matrix;

inline Vector make_vector(size_t n, double init = 0.0) {
    return Matrix(n, 1, init);
}

inline Vector vector_from(std::vector<double> vals) {
    return Matrix(vals.size(), 1, std::move(vals));
}

// ---------------------------------------------------------------------------
// Matrix operations (all return new Matrix — functional style)
// ---------------------------------------------------------------------------

/// Matrix multiply: C = A × B  (A: m×n, B: n×p → C: m×p)
inline Matrix matmul(const Matrix& A, const Matrix& B) {
    if (A.cols() != B.rows()) {
        throw std::invalid_argument("matmul: dimension mismatch");
    }
    Matrix C(A.rows(), B.cols(), 0.0);
    for (size_t i = 0; i < A.rows(); ++i) {
        for (size_t k = 0; k < A.cols(); ++k) {
            double aik = A(i, k);
            if (aik == 0.0) continue; // skip zeros for sparse-ish matrices
            for (size_t j = 0; j < B.cols(); ++j) {
                C(i, j) += aik * B(k, j);
            }
        }
    }
    return C;
}

/// Transpose
inline Matrix transpose(const Matrix& A) {
    Matrix At(A.cols(), A.rows());
    for (size_t i = 0; i < A.rows(); ++i) {
        for (size_t j = 0; j < A.cols(); ++j) {
            At(j, i) = A(i, j);
        }
    }
    return At;
}

/// Element-wise addition
inline Matrix elem_add(const Matrix& A, const Matrix& B) {
    if (A.rows() != B.rows() || A.cols() != B.cols()) {
        throw std::invalid_argument("elem_add: dimension mismatch");
    }
    Matrix C(A.rows(), A.cols());
    for (size_t i = 0; i < C.size(); ++i) {
        C.data_[i] = A.data_[i] + B.data_[i];
    }
    return C;
}

/// Element-wise subtraction
inline Matrix elem_sub(const Matrix& A, const Matrix& B) {
    if (A.rows() != B.rows() || A.cols() != B.cols()) {
        throw std::invalid_argument("elem_sub: dimension mismatch");
    }
    Matrix C(A.rows(), A.cols());
    for (size_t i = 0; i < C.size(); ++i) {
        C.data_[i] = A.data_[i] - B.data_[i];
    }
    return C;
}

/// Element-wise multiplication (Hadamard product)
inline Matrix elem_mul(const Matrix& A, const Matrix& B) {
    if (A.rows() != B.rows() || A.cols() != B.cols()) {
        throw std::invalid_argument("elem_mul: dimension mismatch");
    }
    Matrix C(A.rows(), A.cols());
    for (size_t i = 0; i < C.size(); ++i) {
        C.data_[i] = A.data_[i] * B.data_[i];
    }
    return C;
}

/// In-place scalar multiply
inline void scale_inplace(Matrix& A, double s) {
    for (auto& v : A.data_) v *= s;
}

/// Scalar multiply (returns new Matrix)
inline Matrix scale(const Matrix& A, double s) {
    Matrix C(A.rows(), A.cols());
    for (size_t i = 0; i < C.size(); ++i) {
        C.data_[i] = A.data_[i] * s;
    }
    return C;
}

/// Dot product of two vectors (each must be N×1 or 1×N)
inline double dot(const Matrix& a, const Matrix& b) {
    if (a.size() != b.size()) {
        throw std::invalid_argument("dot: size mismatch");
    }
    double sum = 0.0;
    for (size_t i = 0; i < a.size(); ++i) {
        sum += a.data_[i] * b.data_[i];
    }
    return sum;
}

/// Sum of all elements
inline double sum(const Matrix& A) {
    return std::accumulate(A.data_.begin(), A.data_.end(), 0.0);
}

/// Maximum element value
inline double max_element(const Matrix& A) {
    if (A.size() == 0) return 0.0;
    return *std::max_element(A.data_.begin(), A.data_.end());
}

/// Index of maximum element (returns column index for a row vector, or row index for col vector)
inline size_t argmax(const Matrix& A) {
    if (A.size() == 0) return 0;
    return static_cast<size_t>(
        std::distance(A.data_.begin(),
                      std::max_element(A.data_.begin(), A.data_.end())));
}

/// L2 norm
inline double norm(const Matrix& A) {
    double s = 0.0;
    for (auto v : A.data_) s += v * v;
    return std::sqrt(s);
}

/// Print matrix (for debugging)
inline std::string to_string(const Matrix& A) {
    std::ostringstream oss;
    oss << std::fixed << std::setprecision(6);
    for (size_t i = 0; i < A.rows(); ++i) {
        oss << "[";
        for (size_t j = 0; j < A.cols(); ++j) {
            if (j > 0) oss << " ";
            oss << std::setw(10) << A(i, j);
        }
        oss << "]\n";
    }
    return oss.str();
}

inline std::ostream& operator<<(std::ostream& os, const Matrix& A) {
    os << to_string(A);
    return os;
}

} // namespace hmm
