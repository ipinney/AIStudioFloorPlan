/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useEffect, useState } from 'react';
import { AUTH_REQUIRED_EVENT, checkPassword, getPassword, setPassword } from '../services/api';

/**
 * Shows a password screen until the API accepts the password. The API enforces
 * it on every call; this screen just collects it and remembers it in this browser.
 */
const PasswordGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [state, setState] = useState<'checking' | 'locked' | 'open'>('checking');
    const [value, setValue] = useState('');
    const [error, setError] = useState('');
    // Once in, keep the app mounted so a later re-prompt doesn't lose work.
    const [wasOpen, setWasOpen] = useState(false);
    useEffect(() => { if (state === 'open') setWasOpen(true); }, [state]);

    useEffect(() => {
        checkPassword(getPassword())
            .then(ok => setState(ok ? 'open' : 'locked'))
            .catch(() => { setState('locked'); setError('Could not reach the server.'); });
        const relock = () => setState('locked');
        window.addEventListener(AUTH_REQUIRED_EVENT, relock);
        return () => window.removeEventListener(AUTH_REQUIRED_EVENT, relock);
    }, []);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        try {
            if (await checkPassword(value)) {
                setPassword(value);
                setState('open');
            } else {
                setError('That password is not right.');
            }
        } catch {
            setError('Could not reach the server.');
        }
    };

    if (state === 'open') return <>{children}</>;
    const gate = (
        <div className={wasOpen ? 'fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4' : 'min-h-screen flex items-center justify-center bg-gray-50 px-4'}>
            {state === 'checking' ? (
                <p className="text-slate-400">Loading…</p>
            ) : (
                <form onSubmit={submit} className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm space-y-4">
                    <h1 className="text-xl font-bold text-slate-900">Floor Plan Wizard</h1>
                    <p className="text-sm text-slate-500">This preview is private. Enter the password to continue.</p>
                    <input type="password" autoFocus value={value} onChange={e => setValue(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="Password" />
                    {error && <p className="text-sm text-red-600">{error}</p>}
                    <button type="submit" className="w-full py-2 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700">Enter</button>
                </form>
            )}
        </div>
    );
    return wasOpen ? <>{children}{gate}</> : gate;
};

export default PasswordGate;
