/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useEffect, useRef, useState } from 'react';
import { Language, getTranslation } from '../lib/i18n';
import { interviewTurn } from '../services/api';
import type { DesignBrief, InterviewMessage } from '../shared/brief';

export interface InterviewState {
    history: InterviewMessage[];
    quickReplies: string[];
    topic: string;
    complete: boolean;
}

interface Step2InterviewProps {
    planImage: string;
    language: Language;
    brief: DesignBrief | null;
    onBriefChange: (brief: DesignBrief) => void;
    interview: InterviewState;
    onInterviewChange: (state: InterviewState) => void;
}

const TOPICS = ['household', 'lifestyle', 'site', 'budget', 'aesthetic', 'rooms', 'review'] as const;

const Step2Interview: React.FC<Step2InterviewProps> = ({ planImage, language, brief, onBriefChange, interview, onInterviewChange }) => {
    const [input, setInput] = useState('');
    const [isThinking, setIsThinking] = useState(false);
    const [error, setError] = useState('');
    const scrollRef = useRef<HTMLDivElement>(null);
    const started = useRef(false);

    const send = async (history: InterviewMessage[]) => {
        setIsThinking(true);
        setError('');
        onInterviewChange({ ...interview, history, quickReplies: [] });
        try {
            const turn = await interviewTurn(planImage, history, brief, language);
            onBriefChange(turn.brief);
            onInterviewChange({
                history: [...history, { role: 'assistant', content: turn.message }],
                quickReplies: turn.quickReplies,
                topic: turn.topic,
                complete: turn.complete,
            });
        } catch (e) {
            console.error('Interview turn failed:', e);
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setIsThinking(false);
        }
    };

    // The architect opens the meeting by reacting to the plan.
    useEffect(() => {
        if (!started.current && interview.history.length === 0) {
            started.current = true;
            send([]);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [interview.history.length, isThinking]);

    const answer = (text: string) => {
        const trimmed = text.trim();
        if (!trimmed || isThinking) return;
        setInput('');
        send([...interview.history, { role: 'user', content: trimmed }]);
    };

    const retry = () => send(interview.history);

    const topicIndex = Math.max(0, TOPICS.indexOf(interview.topic as typeof TOPICS[number]));

    return (
        <div className="w-full max-w-6xl mx-auto">
            <h2 className="text-2xl font-bold mb-2 text-center text-slate-900">{getTranslation('interviewTitle', language)}</h2>
            <p className="text-center text-slate-500 mb-6 max-w-2xl mx-auto">{getTranslation('interviewDescription', language)}</p>

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                {/* Conversation */}
                <div className="lg:col-span-3 flex flex-col border border-slate-200 rounded-xl bg-slate-50 h-[60vh]">
                    <div className="flex gap-1 p-3 border-b border-slate-200">
                        {TOPICS.map((t, i) => (
                            <div key={t} title={getTranslation(`topic_${t}`, language)}
                                className={`h-1.5 flex-1 rounded-full ${interview.complete || i < topicIndex ? 'bg-green-500' : i === topicIndex ? 'bg-indigo-600' : 'bg-slate-200'}`} />
                        ))}
                    </div>
                    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
                        {interview.history.map((m, i) => (
                            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[85%] px-4 py-2 rounded-2xl whitespace-pre-wrap ${m.role === 'user' ? 'bg-indigo-600 text-white rounded-br-sm' : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm'}`}>
                                    {m.content}
                                </div>
                            </div>
                        ))}
                        {isThinking && (
                            <div className="flex justify-start">
                                <div className="px-4 py-2 rounded-2xl bg-white border border-slate-200 text-slate-400 animate-pulse">
                                    {getTranslation('architectThinking', language)}
                                </div>
                            </div>
                        )}
                        {error && (
                            <div className="text-sm text-red-600 flex items-center gap-2">
                                <span>{error}</span>
                                <button onClick={retry} className="underline font-semibold">{getTranslation('retry', language)}</button>
                            </div>
                        )}
                    </div>

                    {interview.quickReplies.length > 0 && !isThinking && (
                        <div className="flex flex-wrap gap-2 px-4 pb-2">
                            {interview.quickReplies.map(reply => (
                                <button key={reply} onClick={() => answer(reply)}
                                    className="px-3 py-1 text-sm bg-white border border-indigo-300 text-indigo-700 rounded-full hover:bg-indigo-50">
                                    {reply}
                                </button>
                            ))}
                        </div>
                    )}

                    <form className="flex gap-2 p-3 border-t border-slate-200" onSubmit={e => { e.preventDefault(); answer(input); }}>
                        <textarea
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); answer(input); } }}
                            rows={2}
                            placeholder={getTranslation('interviewPlaceholder', language)}
                            className="flex-1 resize-none px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            disabled={isThinking}
                        />
                        <button type="submit" disabled={isThinking || !input.trim()}
                            className="px-4 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                            {getTranslation('send', language)}
                        </button>
                    </form>
                </div>

                {/* Plan + live brief */}
                <div className="lg:col-span-2 space-y-4">
                    <img src={planImage} alt="Floor plan" className="w-full rounded-xl border border-slate-200" />
                    <BriefPanel brief={brief} language={language} />
                    {!interview.complete && interview.history.length > 2 && (
                        <button onClick={() => answer(getTranslation('wrapUpMessage', language))} disabled={isThinking}
                            className="w-full text-sm text-slate-500 underline hover:text-slate-700 disabled:opacity-50">
                            {getTranslation('wrapUp', language)}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

const BriefPanel: React.FC<{ brief: DesignBrief | null; language: Language }> = ({ brief, language }) => {
    if (!brief) return null;
    const rows: [string, string | null][] = [
        [getTranslation('topic_household', language), [brief.household.occupants, brief.household.pets].filter(Boolean).join(' · ') || null],
        [getTranslation('topic_lifestyle', language), [brief.lifestyle.workFromHome, brief.lifestyle.cooking, brief.lifestyle.entertaining].filter(Boolean).join(' · ') || null],
        [getTranslation('topic_site', language), [brief.site.projectType, brief.site.orientation].filter(Boolean).join(' · ') || null],
        [getTranslation('topic_budget', language), brief.budget.range],
        [getTranslation('topic_aesthetic', language), brief.aesthetic.style],
    ];
    return (
        <div className="border border-slate-200 rounded-xl p-4 bg-white">
            <h3 className="font-bold text-slate-900 mb-2">{getTranslation('designBrief', language)}</h3>
            {brief.summary && <p className="text-sm text-slate-600 mb-3">{brief.summary}</p>}
            <dl className="text-sm space-y-1">
                {rows.map(([label, value]) => (
                    <div key={label} className="flex gap-2">
                        <dt className="font-semibold text-slate-700 w-24 shrink-0">{label}</dt>
                        <dd className={value ? 'text-slate-600' : 'text-slate-300'}>{value || '—'}</dd>
                    </div>
                ))}
            </dl>
            {brief.concerns.length > 0 && (
                <div className="mt-3">
                    <h4 className="text-sm font-semibold text-amber-700">{getTranslation('architectConcerns', language)}</h4>
                    <ul className="text-sm text-amber-800 list-disc ml-5">
                        {brief.concerns.map(c => <li key={c}>{c}</li>)}
                    </ul>
                </div>
            )}
        </div>
    );
};

export default Step2Interview;
