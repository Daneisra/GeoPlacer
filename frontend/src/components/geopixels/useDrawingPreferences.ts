import { useRef, useState } from 'react';
import type { DrawingOptions, DrawingPreferencesEdit, DrawingPreferencesView } from '@geoplacer/engine-service';
import { engineHttp, errorText } from '../../lib/engine';

const legacyPaletteKey = 'geoplacer.drawing.palette.v1';

function readLegacyPalette(): DrawingOptions['palette'] | null {
    try {
        const value = JSON.parse(window.localStorage.getItem(legacyPaletteKey) ?? 'null');
        if (typeof value?.manualOnly === 'boolean' && typeof value.manual === 'string' && value.manual.length <= 4096)
            return { manualOnly: value.manualOnly, manual: value.manual };
    } catch { /* Existing browser storage is optional. */ }
    return null;
}

type Draft = { templateId: string | null; options: DrawingOptions };
const endpoint = '/connector/drawing/preferences';

export function useDrawingPreferences(preferences: DrawingPreferencesView, refresh: () => Promise<void>) {
    const [legacyPalette] = useState(readLegacyPalette);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [saveError, setSaveError] = useState('');
    const [profileError, setProfileError] = useState('');
    const [saving, setSaving] = useState(false);
    const [managing, setManaging] = useState(false);
    const queue = useRef(Promise.resolve());
    const staged = useRef<Draft | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const { templateId, current, next, explicitDefault } = preferences;
    const migratePalette = preferences.migrateLegacy && current.options.palette.manual === null ? legacyPalette : null;
    const migrate = !!migratePalette || (preferences.migrateLegacy && preferences.restorePreviousScope);
    const selectedDraft = draft?.templateId === templateId ? draft : null;
    const options = selectedDraft?.options ?? (migratePalette ? { ...current.options, palette: migratePalette } : current.options);
    const nextOptions = explicitDefault ? next.options : selectedDraft?.options ?? (migrate ? options : next.options);

    function flush(change = staged.current): Promise<void> {
        clearTimeout(timer.current);
        if (!change) return queue.current;
        if (staged.current === change) staged.current = null;
        setSaving(true);
        const task = queue.current.catch(() => undefined).then(async () => {
            await engineHttp.put(endpoint, { action: 'save', ...change } satisfies DrawingPreferencesEdit);
            await refresh();
            setDraft(previous => previous === change ? null : previous);
            setSaveError('');
        });
        queue.current = task;
        void task.catch(error => {
            if (queue.current === task) {
                staged.current ??= change;
                setSaveError(errorText(error).message);
            }
        }).finally(() => {
            if (queue.current === task && staged.current === null) setSaving(false);
            else if (queue.current === task && staged.current === change) setSaving(false);
        });
        return task;
    }

    function update(patch: Partial<DrawingOptions>) {
        if (staged.current && staged.current.templateId !== templateId) void flush().catch(() => undefined);
        const base = staged.current?.templateId === templateId ? staged.current.options : options;
        const change = { templateId, options: { ...base, ...patch } };
        setDraft(change);
        staged.current = change;
        setSaving(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(change).catch(() => undefined), 250);
    }

    async function persist() {
        if (migrate && !selectedDraft && !staged.current) return flush({ templateId, options });
        return flush();
    }

    async function edit(command: Exclude<DrawingPreferencesEdit, { action: 'save' }>): Promise<boolean> {
        setManaging(true);
        setProfileError('');
        const replacesDraft = command.action === 'load' || command.action === 'reset';
        let unsaved: Draft | null = null;
        try {
            if (replacesDraft) {
                clearTimeout(timer.current);
                unsaved = staged.current;
                await queue.current.catch(() => undefined);
                unsaved ??= staged.current;
                staged.current = null;
            } else await persist();
            await engineHttp.put(endpoint, command);
            await refresh();
            if (replacesDraft) {
                setDraft(null);
                queue.current = Promise.resolve();
                setSaving(false);
                setSaveError('');
            }
            return true;
        } catch (error) {
            if (replacesDraft) {
                staged.current = unsaved;
                setSaving(false);
            }
            setProfileError(errorText(error).message);
            return false;
        } finally {
            setManaging(false);
        }
    }

    return { options, nextOptions, update, persist, edit, saveError, profileError, saving, managing };
}
