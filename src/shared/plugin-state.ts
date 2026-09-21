
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';
import { parseJsonWithBom } from './atomic-json.js';

// Der Schluessel, unter dem DIESES Plugin in ~/.claude/settings.json steht --
// fuer den Fork also `nord-mem@nord-local`, nicht upstreams Eintrag.
//
// Stand bis zum 2026-09-21 auf 'claude-mem@thedotmack' und war damit genau
// verkehrt herum: wer den Fork aktiviert, schaltet upstream ab, und der Worker
// des Forks las das als "ich bin ausgeschaltet" und beendete sich mit exit(0) --
// ohne Ausgabe, ohne Logzeile, weil aus seiner Sicht nichts falsch war. Der
// Umstieg scheiterte daran dreimal und wurde jedes Mal woanders gesucht.
//
// Die Sperre selbst ist richtig: ein abgeschaltetes Plugin soll keinen Worker
// starten. Nur muss sie nach dem eigenen Eintrag sehen.
const PLUGIN_SETTINGS_KEY = 'nord-mem@nord-local';

export function isPluginDisabledInClaudeSettings(): boolean {
  try {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(claudeConfigDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const raw = readFileSync(settingsPath, 'utf-8');
    const settings = parseJsonWithBom<Record<string, any>>(raw);
    return settings?.enabledPlugins?.[PLUGIN_SETTINGS_KEY] === false;
  } catch (error: unknown) {
    logger.error('CONFIG', 'Failed to read Claude settings', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
