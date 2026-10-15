FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /opt/aira
ENV NODE_ENV=test HOME=/tmp XDG_CACHE_HOME=/tmp
RUN npm install --no-audit --no-fund --no-save playwright@1.63.0 \
    && mkdir -p /profiles \
    && chown -R pwuser:pwuser /profiles /opt/aira
COPY --chown=pwuser:pwuser test/docker-v2-browser-isolation.cjs /opt/aira/check.cjs
USER pwuser
CMD ["node","/opt/aira/check.cjs"]
