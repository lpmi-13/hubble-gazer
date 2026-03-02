cd /tmp
curl -fLO https://go.dev/dl/go1.25.7.linux-amd64.tar.gz
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go1.25.7.linux-amd64.tar.gz

# ensure PATH has /usr/local/go/bin (persist + current shell)
grep -q '/usr/local/go/bin' ~/.bashrc || echo 'export PATH=/usr/local/go/bin:$PATH' >> ~/.bashrc
export PATH=/usr/local/go/bin:$PATH
hash -r

# verify (important: local toolchain check)
go version
GOTOOLCHAIN=local go version
go env GOROOT GOVERSION

