FROM mcr.microsoft.com/playwright:v1.63.0-noble

USER root
WORKDIR /opt/aira-computer
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm init -y >/dev/null 2>&1 \
    && npm install --omit=dev express@5.2.1 playwright@1.63.0 \
    && mkdir -p /data \
    && chown -R pwuser:pwuser /data /opt/aira-computer

COPY --chown=pwuser:pwuser runner.mjs /opt/aira-computer/runner.mjs
COPY --chown=pwuser:pwuser action-journal.mjs /opt/aira-computer/action-journal.mjs

USER pwuser
EXPOSE 7777
CMD ["node", "/opt/aira-computer/runner.mjs"]
