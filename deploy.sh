#!/bin/bash
# SenecaChat v19 — Docker deployment script
# Usage: ./deploy.sh [build|start|stop|logs|shell|status]

set -e
CMD=${1:-start}
CONTAINER="senecachat"

case "$CMD" in
  build)
    echo "🔨 Building SenecaChat v19 image (this takes ~5-10 min first time)..."
    docker compose build --no-cache
    echo "✅ Build complete"
    ;;
  start)
    echo "🚀 Starting SenecaChat v19..."
    docker compose up -d
    echo ""
    echo "✅ Running at http://localhost:3000"
    echo "   Data persists in Docker volumes: seneca_data, seneca_workspace"
    echo "   Logs: ./deploy.sh logs"
    echo "   Shell: ./deploy.sh shell"
    ;;
  stop)
    docker compose down
    echo "⛔ Stopped. Data preserved in volumes."
    ;;
  restart)
    docker compose restart seneca
    echo "🔄 Restarted"
    ;;
  logs)
    docker compose logs -f seneca
    ;;
  shell)
    echo "🐚 Opening root shell in container..."
    docker exec -it $CONTAINER bash
    ;;
  status)
    docker compose ps
    echo ""
    docker stats $CONTAINER --no-stream 2>/dev/null || true
    ;;
  clean)
    echo "⚠️  This will delete ALL data. Press Ctrl+C to cancel..."
    sleep 5
    docker compose down -v
    echo "🗑️  Volumes deleted"
    ;;
  pull)
    echo "📦 Pulling latest image layers..."
    docker compose pull
    ;;
  *)
    echo "Usage: ./deploy.sh [build|start|stop|restart|logs|shell|status|clean]"
    exit 1
    ;;
esac
