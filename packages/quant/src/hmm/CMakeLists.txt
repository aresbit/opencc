cmake_minimum_required(VERSION 3.20)
project(hmm_framework VERSION 1.0.0 LANGUAGES CXX)

# ------------------------------------------------------------------
# C++20 required for concepts, std::numbers, std::format, ranges
# ------------------------------------------------------------------
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ------------------------------------------------------------------
# Compiler flags
# ------------------------------------------------------------------
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    add_compile_options(-Wall -Wextra -Wpedantic -O2)
endif()

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
    add_compile_options(-Wno-unused-parameter)
endif()

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU")
    add_compile_options(-Wno-unused-parameter)
endif()

# ------------------------------------------------------------------
# HMM library (shared, built from .cpp implementation files)
# ------------------------------------------------------------------
add_library(hmm_lib STATIC
    forward.cpp
    backward.cpp
    viterbi.cpp
    baum_welch.cpp
    regime_detector.cpp
)

target_include_directories(hmm_lib PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
)

# ------------------------------------------------------------------
# Tests
# ------------------------------------------------------------------
enable_testing()

add_executable(test_hmm
    test/test_hmm.cpp
)

target_link_libraries(test_hmm PRIVATE hmm_lib)

# Register test with CTest
add_test(NAME hmm_unit_test COMMAND test_hmm)

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
message(STATUS "HMM Framework v1.0.0")
message(STATUS "  C++ Standard: C++20")
message(STATUS "  Compiler:     ${CMAKE_CXX_COMPILER_ID}")
message(STATUS "  Build type:   ${CMAKE_BUILD_TYPE}")
message(STATUS "  Tests:        ON")
