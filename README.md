# 9Router LITE Proxy

Restricted OpenAI-compatible API endpoint that only allows one model: **LITE**.

Proxies requests to [9Router](https://ai.wsd.my.id) while:
- ✅ **Enforcing a single token** — only requests with the correct `Authorization: Bearer <token>` pass through
- ✅ **Forcing model to LITE** — any model requested is silently overridden to `LITE`
- ✅ **Filtering `/v1/models`** — only shows the `LITE` model
- ✅ **Usage dashboard** — real-time stats at `/usage` (total/today requests, tokens, by model, recent entries)
- ✅ **Streaming support** — SSE passthrough works

## Quick Start

```bash
# Clone
git clone https://github.com/aadiityaak/9router-lite-proxy.git
cd 9router-lite-proxy

# Configure
cp .env.example .env
# Edit .env with your tokens

# Run
node proxy.js
```

By default listens on `http://127.0.0.1:9099`.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LITE_TOKEN` | Token required from clients calling this proxy |
| `UPSTREAM_TOKEN` | Full `Authorization` header value for the upstream 9Router |

## Deploy with systemd

```bash
sudo cp lite-proxy.service.example /etc/systemd/system/lite-proxy.service
# Edit Environment variables in the service file
sudo systemctl daemon-reload
sudo systemctl enable --now lite-proxy
```

## Behind Nginx

Example nginx config with SSL:

```nginx
server {
    listen 443 ssl;
    server_name lite.wsd.my.id;

    ssl_certificate /etc/letsencrypt/live/lite.wsd.my.id/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lite.wsd.my.id/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9099;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}

server {
    listen 80;
    server_name lite.wsd.my.id;
    return 301 https://$host$request_uri;
}
```

## API Usage

```bash
curl https://lite.wsd.my.id/v1/chat/completions \
  -H "Authorization: Bearer $LITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "any-model-here",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

The model field is always forced to `LITE` regardless of what you send.

## Dashboard

Open `https://your-domain/usage` for real-time usage stats.

## License

MIT
