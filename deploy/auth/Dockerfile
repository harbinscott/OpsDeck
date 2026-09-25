FROM ubuntu:24.04 AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libpam0g-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY opsdeck-auth.c ./
RUN mkdir /out && \
    cc -std=c11 -O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE -Wformat -Wformat-security -Werror=format-security -Wl,-z,relro,-z,now -pie -o /out/opsdeck-auth opsdeck-auth.c -lpam
FROM scratch
COPY --from=build /out/opsdeck-auth /opsdeck-auth-linux-amd64
