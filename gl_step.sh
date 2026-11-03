curl -sSfL -o gitleaks.tar.gz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
echo "${GITLEAKS_SHA256}  gitleaks.tar.gz" | sha256sum -c -
tar -xzf gitleaks.tar.gz gitleaks
./gitleaks git --redact --verbose --exit-code 1 .

