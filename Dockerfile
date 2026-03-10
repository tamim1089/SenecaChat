########################################################################
# SenecaChat v19 — Full-power AI agent sandbox
# Base: Ubuntu 24.04 LTS | runs as root | persistent via docker volume
########################################################################
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    HOME=/root \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    NODE_ENV=production \
    PATH="/root/.cargo/bin:/root/.local/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# ── Core system & locale ─────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    locales tzdata ca-certificates curl wget gnupg lsb-release apt-transport-https \
    software-properties-common build-essential && \
    locale-gen en_US.UTF-8 && \
    apt-get clean

# ── Shell & terminal essentials ──────────────────────────────────────────
# NOTE: 'more' removed (part of util-linux), 'micro' installed separately below
RUN apt-get install -y \
    bash zsh fish tmux screen \
    coreutils util-linux binutils \
    nano vim neovim emacs-nox \
    less bat pv \
    man-db manpages manpages-dev \
    && apt-get clean

# Install micro editor from official installer (not in Ubuntu 24.04 apt)
RUN curl https://getmic.ro | bash && mv micro /usr/local/bin/ || true

# ── File & archive tools ─────────────────────────────────────────────────
# NOTE: 'scp' removed (part of openssh-client, installed in Networking section)
RUN apt-get install -y \
    file tree fd-find fzf ripgrep \
    zip unzip tar gzip bzip2 xz-utils zstd p7zip-full \
    rsync rclone \
    inotify-tools \
    && apt-get clean

# ── Text processing & data tools ─────────────────────────────────────────
# NOTE: 'awk' removed (virtual pkg, covered by gawk/mawk); 'diff-so-fancy' removed (npm pkg, not apt); 'yq' removed (not in Ubuntu 24.04 apt)
RUN apt-get install -y \
    grep sed gawk mawk \
    jq xmlstarlet \
    miller csvkit \
    pandoc \
    wdiff colordiff \
    && apt-get clean

# Install yq from binary release
RUN wget -qO /usr/local/bin/yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 \
    && chmod +x /usr/local/bin/yq || true

# Install diff-so-fancy via npm (after Node.js is set up) — done in Node section

# ── Networking ──────────────────────────────────────────────────────────
RUN apt-get install -y \
    curl wget httpie \
    netcat-openbsd socat \
    nmap masscan \
    traceroute mtr iputils-ping dnsutils whois \
    tcpdump net-tools iproute2 \
    openssh-client sshpass \
    proxychains4 tor \
    && apt-get clean

# ── Security & pentesting ────────────────────────────────────────────────
# NOTE: metasploit-framework not in standard apt — skipped gracefully
RUN apt-get install -y \
    nmap nikto sqlmap \
    hydra john hashcat \
    openssl libssl-dev \
    gnupg gpg \
    binwalk foremost \
    && apt-get clean || true

# ── Version control ──────────────────────────────────────────────────────
RUN apt-get install -y \
    git git-lfs git-extras \
    subversion mercurial \
    && git lfs install --system \
    && apt-get clean

# ── Languages: Python 3 ──────────────────────────────────────────────────
RUN apt-get install -y \
    python3 python3-pip python3-venv python3-dev python3-full \
    python3-setuptools python3-wheel \
    ipython3 \
    && apt-get clean

# Python packages
# NOTE: --ignore-installed needed to override debian-managed packages (blinker, etc.)
# Split into two RUN layers: core packages first, then heavy ML packages with fallback
RUN pip3 install --break-system-packages --ignore-installed \
    numpy pandas scipy matplotlib seaborn plotly bokeh \
    scikit-learn statsmodels \
    requests httpx aiohttp flask fastapi uvicorn \
    beautifulsoup4 lxml \
    scrapy \
    paramiko fabric invoke \
    python-dotenv pyyaml toml \
    rich click typer \
    pillow imageio \
    pypdf2 reportlab \
    sqlalchemy alembic psycopg2-binary \
    redis pymongo \
    pytest pytest-asyncio black flake8 mypy \
    watchdog schedule \
    openai anthropic

# Heavy ML packages — best effort, won't fail the build if they error
RUN pip3 install --break-system-packages --ignore-installed \
    playwright weasyprint \
    transformers \
    torch torchvision --index-url https://download.pytorch.org/whl/cpu \
    2>/dev/null || pip3 install --break-system-packages --ignore-installed \
    playwright weasyprint transformers || true

# ── Languages: Node.js 22 LTS ────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g \
    npm@latest yarn pnpm bun \
    ts-node typescript tsx \
    nodemon pm2 \
    prettier eslint \
    http-server serve \
    diff-so-fancy \
    @anthropic-ai/sdk openai \
    && apt-get clean

# ── Languages: Go ────────────────────────────────────────────────────────
RUN apt-get install -y golang-go && apt-get clean

# ── Languages: Rust ──────────────────────────────────────────────────────
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable && \
    /root/.cargo/bin/rustup component add rustfmt clippy

# ── Languages: Ruby, Lua, Perl ───────────────────────────────────────────
RUN apt-get install -y ruby-full lua5.4 perl && apt-get clean

# ── Databases: SQLite, PostgreSQL client, MySQL client, Redis ────────────
# NOTE: 'mysql-client' renamed to 'default-mysql-client' in Ubuntu 24.04
RUN apt-get install -y \
    sqlite3 libsqlite3-dev \
    postgresql-client \
    default-mysql-client \
    redis-tools \
    && apt-get clean

# ── Docker CLI (so agent can manage containers in --privileged mode) ──────
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y docker-ce-cli docker-compose-plugin && apt-get clean

# ── GitHub CLI ───────────────────────────────────────────────────────────
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && apt-get clean

# ── Cloud CLIs ───────────────────────────────────────────────────────────
RUN pip3 install --break-system-packages --ignore-installed awscli 2>/dev/null || true
RUN pip3 install --break-system-packages --ignore-installed azure-cli 2>/dev/null || true

# ── Kubernetes / infra ───────────────────────────────────────────────────
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && mv kubectl /usr/local/bin/ || true
RUN pip3 install --break-system-packages --ignore-installed ansible 2>/dev/null || true

# ── Image & document processing ──────────────────────────────────────────
RUN apt-get install -y \
    imagemagick ffmpeg \
    ghostscript poppler-utils \
    tesseract-ocr libtesseract-dev \
    wkhtmltopdf \
    && apt-get clean

# ── Monitoring & profiling ───────────────────────────────────────────────
# NOTE: 'perf-tools-unstable' doesn't exist — using linux-tools-generic
RUN apt-get install -y \
    htop btop iotop nethogs iftop \
    sysstat lsof strace ltrace \
    valgrind \
    && apt-get clean || true
RUN apt-get install -y linux-tools-generic 2>/dev/null || true

# ── Misc handy tools ─────────────────────────────────────────────────────
RUN apt-get install -y \
    parallel \
    bc \
    expect \
    dialog whiptail \
    cowsay fortune \
    asciinema \
    && apt-get clean

# ── Set up workspace & uploads dir ───────────────────────────────────────
RUN mkdir -p /workspace /workspace/uploads /workspace/data /workspace/tmp
WORKDIR /workspace

# ── Copy app ─────────────────────────────────────────────────────────────
COPY . /app/
WORKDIR /app
RUN cd /app && npm install --production

# ── Persistent data volume (SQLite DB, uploads, model data) ──────────────
VOLUME ["/app/data", "/workspace"]

# ── Git global config skeleton ───────────────────────────────────────────
RUN git config --global init.defaultBranch main && \
    git config --global core.editor nano && \
    git config --global color.ui auto

# ── Shell config ─────────────────────────────────────────────────────────
RUN echo 'export PS1="\[\033[01;32m\]root@seneca\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]# "' >> /root/.bashrc && \
    echo 'alias ll="ls -la"' >> /root/.bashrc && \
    echo 'alias la="ls -la"' >> /root/.bashrc && \
    echo 'alias ..="cd .."' >> /root/.bashrc && \
    echo 'export TERM=xterm-256color' >> /root/.bashrc

EXPOSE 3000

CMD ["node", "server.js"]
