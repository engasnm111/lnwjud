import { describe, expect, it } from 'vitest';

import { rankSkillMatches, selectAutoSkillMatches } from './skill-routing.js';

describe('skill routing', () => {
  it('ranks a relevant trusted skill from natural-language intent', () => {
    const ranked = rankSkillMatches([
      { id: 'user/diagnosing-bugs', name: 'diagnosing-bugs', description: 'Diagnose hard bugs and performance regressions', source: 'user', trustTier: 'user' },
      { id: 'user/frontend-design', name: 'frontend-design', description: 'Design visual frontend interfaces', source: 'user', trustTier: 'user' },
    ], 'diagnose the hard lifecycle bug and performance regression', 2);

    expect(ranked[0]?.skill.id).toBe('user/diagnosing-bugs');
    expect(selectAutoSkillMatches(ranked).map((match) => match.skill.id)).toEqual(['user/diagnosing-bugs']);
  });

  it('does not auto-load an external skill unless the user names it explicitly', () => {
    const skills = [
      { id: 'extra:repo/diagnosing-bugs', name: 'diagnosing-bugs', description: 'Diagnose hard bugs and performance regressions', source: 'extra:repo', trustTier: 'external' },
    ];

    expect(selectAutoSkillMatches(rankSkillMatches(skills, 'diagnose the hard bug and performance regression', 2))).toEqual([]);

    const explicit = selectAutoSkillMatches(rankSkillMatches(skills, 'use skill diagnosing-bugs for this task', 2));
    expect(explicit.map((match) => match.skill.id)).toEqual(['extra:repo/diagnosing-bugs']);
    expect(explicit[0]?.explicit).toBe(true);
  });
});
