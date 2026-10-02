/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import * as z from 'zod/v4';

/**
 * The Design Brief: what an architect learns in the programming interview.
 * Every later step (renderings, scenes, presentation) is driven by it.
 * Unknown fields stay null / empty until the homeowner answers.
 */
export const DesignBriefSchema = z.object({
    household: z.object({
        occupants: z.string().nullable().describe('Who lives here: adults, kids and their ages, guests who stay often'),
        pets: z.string().nullable(),
        accessibility: z.string().nullable().describe('Mobility needs, aging in place, stairs'),
    }),
    lifestyle: z.object({
        workFromHome: z.string().nullable(),
        cooking: z.string().nullable().describe('How much and how they cook, who cooks'),
        entertaining: z.string().nullable(),
        dailyRoutines: z.string().nullable().describe('Morning rush, where things land at the door, quiet hours'),
        storagePainPoints: z.string().nullable(),
    }),
    site: z.object({
        projectType: z.string().nullable().describe('New build, remodel, furnishing an existing home'),
        orientation: z.string().nullable().describe('Which way the main windows face / north arrow'),
        climate: z.string().nullable(),
        views: z.string().nullable(),
        noiseAndPrivacy: z.string().nullable(),
        fixedConstraints: z.string().nullable().describe('Walls, plumbing, HOA or code limits that cannot change'),
    }),
    budget: z.object({
        range: z.string().nullable(),
        splurgeOn: z.array(z.string()),
        saveOn: z.array(z.string()),
        timeline: z.string().nullable(),
    }),
    aesthetic: z.object({
        style: z.string().nullable().describe('A short style name to drive the renderings, e.g. "warm Japandi"'),
        materials: z.array(z.string()),
        palette: z.array(z.string()),
        loves: z.array(z.string()),
        dislikes: z.array(z.string()),
    }),
    rooms: z.array(z.object({
        name: z.string(),
        needs: z.string().describe('What this room has to do for this household'),
    })),
    planObservations: z.array(z.string()).describe('What the architect notices in the floor plan'),
    concerns: z.array(z.string()).describe('Conflicts between the plan and how they live, raised to the homeowner'),
    summary: z.string().describe('Two or three sentences a designer could work from'),
});

export type DesignBrief = z.infer<typeof DesignBriefSchema>;

export const InterviewTurnSchema = z.object({
    message: z.string().describe('What the architect says next: a brief reaction, then usually one question'),
    quickReplies: z.array(z.string()).describe('Two to five short tap-to-answer options; empty for open questions'),
    topic: z.enum(['household', 'lifestyle', 'site', 'budget', 'aesthetic', 'rooms', 'review']),
    brief: DesignBriefSchema.describe('The full brief so far, updated with everything learned'),
    complete: z.boolean().describe('True once the brief is solid enough to design from and the homeowner has confirmed the summary'),
});

export type InterviewTurn = z.infer<typeof InterviewTurnSchema>;

export interface InterviewMessage {
    role: 'user' | 'assistant';
    content: string;
}

export function emptyBrief(): DesignBrief {
    return {
        household: { occupants: null, pets: null, accessibility: null },
        lifestyle: { workFromHome: null, cooking: null, entertaining: null, dailyRoutines: null, storagePainPoints: null },
        site: { projectType: null, orientation: null, climate: null, views: null, noiseAndPrivacy: null, fixedConstraints: null },
        budget: { range: null, splurgeOn: [], saveOn: [], timeline: null },
        aesthetic: { style: null, materials: [], palette: [], loves: [], dislikes: [] },
        rooms: [],
        planObservations: [],
        concerns: [],
        summary: '',
    };
}

/** A compact plain-text rendering of the brief for use inside prompts. */
export function briefToText(brief: DesignBrief | null | undefined): string {
    if (!brief) return '';
    const lines: string[] = [];
    const add = (label: string, value: string | null | string[]) => {
        if (Array.isArray(value)) {
            if (value.length) lines.push(`${label}: ${value.join(', ')}`);
        } else if (value) {
            lines.push(`${label}: ${value}`);
        }
    };
    add('Household', brief.household.occupants);
    add('Pets', brief.household.pets);
    add('Accessibility', brief.household.accessibility);
    add('Work from home', brief.lifestyle.workFromHome);
    add('Cooking', brief.lifestyle.cooking);
    add('Entertaining', brief.lifestyle.entertaining);
    add('Routines', brief.lifestyle.dailyRoutines);
    add('Storage', brief.lifestyle.storagePainPoints);
    add('Project', brief.site.projectType);
    add('Orientation', brief.site.orientation);
    add('Climate', brief.site.climate);
    add('Views', brief.site.views);
    add('Budget', brief.budget.range);
    add('Splurge on', brief.budget.splurgeOn);
    add('Save on', brief.budget.saveOn);
    add('Style', brief.aesthetic.style);
    add('Materials', brief.aesthetic.materials);
    add('Palette', brief.aesthetic.palette);
    add('Loves', brief.aesthetic.loves);
    add('Dislikes', brief.aesthetic.dislikes);
    for (const room of brief.rooms) lines.push(`Room - ${room.name}: ${room.needs}`);
    if (brief.summary) lines.push(`Summary: ${brief.summary}`);
    return lines.join('\n');
}
