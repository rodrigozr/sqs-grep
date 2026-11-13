# AWS Emulator (https://docs.aws.amazon.com/emulator/) for the integration tests.
#
# AWS does not publish a prebuilt image, so this follows the Dockerfile from
# "Getting started with Docker", pinned to one release for reproducible test runs
# and picking the RPM that matches the build platform (x86_64 or aarch64).
# test/integration.test.ts builds and runs it; it is not meant for anything else.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
ARG AWS_EMULATOR_VERSION
RUN test -n "${AWS_EMULATOR_VERSION}" \
    && curl -fsSL -o /tmp/aws-emulator.rpm \
       "https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/aws-emulator-${AWS_EMULATOR_VERSION}-1-$(uname -m).rpm" \
    && rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \
    && mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator
EXPOSE 9297
# Listen on all addresses inside the container so that the port can be published
# (the test publishes it on 127.0.0.1 only)
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
