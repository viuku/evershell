import { describe, expect, it } from 'vitest';
import { guessLanguage } from '../edit-language';

describe('guessLanguage', () => {
  it('按文件名和后缀', () => {
    expect(guessLanguage('/etc/nginx/nginx.conf')).toBe('nginx');
    expect(guessLanguage('/etc/nginx/sites-enabled/default')).toBe('nginx');
    expect(guessLanguage('/etc/nginx/fastcgi_params')).toBe('nginx');
    expect(guessLanguage('/opt/app/docker-compose.yml')).toBe('yaml');
    expect(guessLanguage('/opt/app/Dockerfile')).toBe('dockerfile');
    expect(guessLanguage('/opt/app/.env.production')).toBe('shell');
    expect(guessLanguage('/root/.bashrc')).toBe('shell');
    expect(guessLanguage('/etc/ssh/sshd_config')).toBe('ini');
    expect(guessLanguage('/etc/systemd/system/app.service')).toBe('ini');
    expect(guessLanguage('/etc/sysctl.conf')).toBe('ini');
    expect(guessLanguage('/srv/app/package.json')).toBe('json');
    expect(guessLanguage('/srv/app/main.py')).toBe('python');
    expect(guessLanguage('/srv/app/index.ts')).toBe('typescript');
    expect(guessLanguage('/var/www/html/index.html')).toBe('xml');
  });

  it('没后缀的看第一行', () => {
    expect(guessLanguage('/usr/local/bin/backup', '#!/bin/bash')).toBe('shell');
    expect(guessLanguage('/usr/local/bin/tool', '#!/usr/bin/env python3')).toBe('python');
    expect(guessLanguage('/usr/local/bin/run', '#!/usr/bin/env node')).toBe('javascript');
    expect(guessLanguage('/etc/hostname', 'web-01')).toBe('plain');
  });
});
