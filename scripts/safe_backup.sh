wsl -d Ubuntu-22.04 bash -c "cd /home/yuu/dev/slack-bot && pwd && ls -la"
wsl -d Ubuntu-22.04 bash -c "cd /home/yuu/dev/slack-bot && echo '#!/bin/bash' > scripts/safe_backup.sh"
wsl -d Ubuntu-22.04 bash -c "cd /home/yuu/dev/slack-bot && git remote -v"
wsl -d Ubuntu-22.04 --exec bash -c "cd /home/yuu/dev/slack-bot && pwd && git remote -v"

