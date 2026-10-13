FROM python:3.13.8-slim-bookworm@sha256:61169c2bdb8e6bb44a8dfad33f569d324d52f079fded9a204b322a6fb9c9f799 AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake ca-certificates xz-utils && rm -rf /var/lib/apt/lists/*
COPY voice/fetch_asset.py /fetch_asset.py
WORKDIR /build
RUN python3 /fetch_asset.py whisper.tar.gz && tar xf whisper.tar.gz --strip-components=1
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXE_LINKER_FLAGS="-static-libgcc -static-libstdc++" -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DGGML_NATIVE=OFF -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_AVX_VNNI=OFF -DGGML_AVX512=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_CPU_ARM_ARCH=armv8-a -DGGML_CPU_KLEIDIAI=OFF -DGGML_CPU_ALL_VARIANTS=OFF -DGGML_OPENMP=OFF -DGGML_ACCELERATE=OFF -DGGML_METAL=OFF -DGGML_BLAS=OFF && cmake --build build --target whisper-cli -j2
WORKDIR /decoder
RUN python3 /fetch_asset.py ffmpeg.tar.xz && tar xf ffmpeg.tar.xz --strip-components=1
# Built-in Opus decoder; no external libraries or GPL/nonfree components.
RUN ./configure --disable-everything --disable-autodetect --disable-network --disable-x86asm --disable-doc --disable-debug --disable-shared --enable-static --enable-ffmpeg --enable-ffprobe --enable-protocol=file,pipe --enable-demuxer=ogg --enable-decoder=opus --enable-parser=opus --enable-encoder=pcm_s16le --enable-muxer=pcm_s16le --enable-filter=aresample,aformat,anull && make -j2 ffmpeg ffprobe
WORKDIR /model
RUN python3 /fetch_asset.py ggml-base.bin
RUN mkdir /licenses && cp /build/LICENSE /licenses/whisper-cpp-MIT && cp /decoder/COPYING.LGPLv2.1 /licenses/FFmpeg-LGPLv2.1 && cp /decoder/COPYING.LGPLv3 /licenses/FFmpeg-LGPLv3 && /decoder/ffmpeg -version > /licenses/decoder-build.txt && /build/build/bin/whisper-cli --help > /licenses/whisper-help.txt 2>&1 && dpkg-query -W > /licenses/build-packages.txt
FROM python:3.13.8-slim-bookworm@sha256:61169c2bdb8e6bb44a8dfad33f569d324d52f079fded9a204b322a6fb9c9f799
WORKDIR /opt/voice
COPY --from=build /build/build/bin/whisper-cli ./whisper-cli
COPY --from=build /decoder/ffmpeg /decoder/ffprobe ./
COPY --from=build /model/ggml-base.bin ./
COPY --from=build /licenses ./licenses
COPY voice/WHISPER-MODEL-LICENSE ./licenses/whisper-model-MIT
COPY voice/pins.json voice/worker.py ./
RUN python3 -c 'import hashlib,json,pathlib; p=pathlib.Path("/opt/voice"); (p/"runtime-manifest.json").write_text(json.dumps({"runtime":"d1be6fde11ac6e0407606b4e42fe72d34add8037","decoder":"ffmpeg-7.1.1-ogg-opus-pcm16-v1","files":{n:hashlib.sha256((p/n).read_bytes()).hexdigest() for n in ("whisper-cli","ffmpeg","ffprobe")}}))' && chmod 0555 whisper-cli ffmpeg ffprobe && chmod 0444 runtime-manifest.json
ENV PYTHONDONTWRITEBYTECODE=1
RUN mkdir -p /voice-spool && chown 1000:1000 /voice-spool && chmod 0700 /voice-spool
USER 1000:1000
CMD ["python3", "/opt/voice/worker.py"]
