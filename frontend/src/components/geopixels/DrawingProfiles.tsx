import { useState } from 'react';
import type { DrawingPreferencesEdit, DrawingPreferencesView } from '@geoplacer/engine-service';

export function DrawingProfiles({ preferences, edit, disabled, error }: {
    preferences: DrawingPreferencesView;
    edit: (command: Exclude<DrawingPreferencesEdit, { action: 'save' }>) => Promise<boolean>;
    disabled: boolean;
    error: string;
}) {
    const [profileId, setProfileId] = useState('');
    const [name, setName] = useState('');
    const [message, setMessage] = useState('');
    const profile = preferences.profiles.find(item => item.id === profileId);
    const validName = name.trim().length > 0;

    async function run(command: Exclude<DrawingPreferencesEdit, { action: 'save' }>, result: string) {
        setMessage('');
        if (await edit(command)) setMessage(result);
    }

    return <fieldset className="drawing-option-section" disabled={disabled}>
        <legend>Configurations enregistrées</legend>
        <p className="drawing-option-note">{preferences.templateId ? 'Les réglages du dessin sont enregistrés automatiquement. ' : ''}
            {preferences.explicitDefault ? 'Les nouveaux dessins utilisent la configuration par défaut.' : 'Les nouveaux dessins reprennent les derniers réglages enregistrés.'}</p>
        <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void run({ action: 'default', templateId: preferences.templateId }, 'Configuration par défaut enregistrée.')}>Définir comme configuration par défaut</button>
            <button type="button" onClick={() => {
                if (window.confirm('Rétablir les réglages d’origine dans ce formulaire ?'))
                    void run({ action: 'reset', templateId: preferences.templateId }, 'Réglages d’origine rétablis.');
            }}>Réinitialiser</button>
        </div>
        <details className="drawing-option-advanced">
            <summary>Profils de configuration</summary>
            <div className="drawing-options-grid">
                <div className="drawing-option-field">
                    <label htmlFor="drawing-profile">Profil enregistré</label>
                    <select id="drawing-profile" value={profile?.id ?? ''} onChange={event => {
                        const selected = preferences.profiles.find(item => item.id === event.target.value);
                        setProfileId(selected?.id ?? '');
                        setName(selected?.name ?? '');
                        setMessage('');
                    }}>
                        <option value="">Choisir un profil</option>
                        {preferences.profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                </div>
                <div className="drawing-option-field">
                    <label htmlFor="drawing-profile-name">Nom du profil</label>
                    <input id="drawing-profile-name" maxLength={80} value={name} onChange={event => setName(event.target.value)} />
                </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" disabled={!validName} onClick={() => void run({ action: 'create', templateId: preferences.templateId, name }, 'Profil créé avec les réglages affichés.')}>Créer un profil</button>
                <button type="button" disabled={!profile} onClick={() => { if (profile) void run({ action: 'load', id: profile.id, templateId: preferences.templateId }, 'Profil chargé dans le formulaire.'); }}>Charger</button>
                <button type="button" disabled={!profile || !validName} onClick={() => { if (profile) void run({ action: 'rename', id: profile.id, name }, 'Profil renommé.'); }}>Renommer</button>
                <button type="button" disabled={!profile} onClick={() => {
                    if (profile && window.confirm(`Supprimer le profil « ${profile.name} » ?`))
                        void run({ action: 'delete', id: profile.id }, 'Profil supprimé.');
                }}>Supprimer</button>
            </div>
        </details>
        {error && <p className="drawing-option-note" role="alert">{error}</p>}
        {message && <p className="drawing-option-note" role="status">{message}</p>}
    </fieldset>;
}
