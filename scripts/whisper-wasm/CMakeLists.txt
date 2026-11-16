cmake_minimum_required(VERSION 3.16)
project(lvw_whisper CXX C)
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -pthread -msimd128")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -pthread -msimd128")
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
add_subdirectory(${WHISPER_SRC} whisper)
add_executable(lvw-whisper lvw_whisper.cpp)
target_link_libraries(lvw-whisper PRIVATE whisper)
set_target_properties(lvw-whisper PROPERTIES LINK_FLAGS " \
  --bind -lworkerfs.js \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createWhisper -s ENVIRONMENT=worker \
  -s USE_PTHREADS=1 -s PTHREAD_POOL_SIZE=8 -s PTHREAD_POOL_SIZE_STRICT=0 \
  -s INITIAL_MEMORY=256MB -s MAXIMUM_MEMORY=4GB -s ALLOW_MEMORY_GROWTH=1 \
  -s FORCE_FILESYSTEM=1 -s EXPORTED_RUNTIME_METHODS=['FS'] \
  -O3")
