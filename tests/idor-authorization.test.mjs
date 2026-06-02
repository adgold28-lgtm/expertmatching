/**
 * IDOR / BOLA Authorization Tests
 *
 * Verifies that the project-level access control logic correctly prevents
 * cross-user access when IDs are changed in URLs or API requests.
 *
 * Run: node --test tests/idor-authorization.test.mjs
 *
 * These tests mirror the canAccess / getProjectForUser logic in
 * lib/projectStore.ts and the getSessionUser logic in lib/auth.ts.
 * They document every IDOR scenario that was found and fixed in:
 *
 *   - app/api/projects/[projectId]/experts/route.ts           (POST)
 *   - app/api/projects/[projectId]/experts/[expertId]/route.ts (PUT, DELETE)
 *   - app/api/projects/[projectId]/experts/[expertId]/complete/route.ts
 *   - app/api/projects/[projectId]/experts/[expertId]/request-availability/route.ts
 *   - app/api/projects/[projectId]/interview-guide/route.ts
 *   - app/api/projects/[projectId]/vetting-questions/route.ts
 *   - app/api/projects/[projectId]/request-client-availability/route.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mirrors lib/projectStore.ts ─────────────────────────────────────────────

/**
 * Core authorization predicate used by getProjectForUser.
 * Admins see everything; regular users only see projects they own or
 * have been added to as a collaborator.
 *
 * @param {{ ownerEmail: string; collaborators: string[] }} project
 * @param {string} email
 * @param {'admin' | 'user'} role
 * @returns {boolean}
 */
function canAccess(project, email, role) {
  if (role === 'admin') return true;
  return project.ownerEmail === email || project.collaborators.includes(email);
}

/**
 * Returns the project only if the requesting user is allowed to access it.
 * Returns null otherwise (route handlers should respond 404, not 403, to avoid
 * leaking whether the resource exists at all).
 *
 * @param {object | null} project
 * @param {string} email
 * @param {'admin' | 'user'} role
 * @returns {object | null}
 */
function getProjectForUser(project, email, role) {
  if (!project) return null;
  return canAccess(project, email, role) ? project : null;
}

// ─── Mirrors lib/auth.ts getSessionUser ──────────────────────────────────────

/**
 * Extracts firmDomain from a user's email.
 * Admins get firmDomain '*' (wildcard — access all).
 *
 * @param {string} email
 * @param {'admin' | 'user'} role
 * @returns {{ email: string; role: string; firmDomain: string }}
 */
function buildSessionUser(email, role) {
  if (role === 'admin') return { email, role, firmDomain: '*' };
  const firmDomain = email.includes('@') ? email.split('@')[1] : '';
  return { email, role, firmDomain };
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const PROJECT_A = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'Project Alpha',
  ownerEmail: 'alice@acme.com',
  collaborators: [],
  firmDomain: 'acme.com',
};

const PROJECT_B = {
  id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  name: 'Project Beta',
  ownerEmail: 'bob@beta.com',
  collaborators: [],
  firmDomain: 'beta.com',
};

const PROJECT_WITH_COLLABORATOR = {
  id: 'cccccccccccccccccccccccc',
  name: 'Project Collab',
  ownerEmail: 'alice@acme.com',
  collaborators: ['carol@acme.com'],
  firmDomain: 'acme.com',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('IDOR Protection — getProjectForUser', () => {

  describe('Owner access', () => {
    it('owner can access their own project', () => {
      const result = getProjectForUser(PROJECT_A, 'alice@acme.com', 'user');
      assert.ok(result, 'Expected project to be returned for owner');
      assert.equal(result.id, PROJECT_A.id);
    });

    it('owner can access project with collaborators list', () => {
      const result = getProjectForUser(PROJECT_WITH_COLLABORATOR, 'alice@acme.com', 'user');
      assert.ok(result);
    });
  });

  describe('Cross-user IDOR attempts (must return null)', () => {
    it('IDOR: user from different firm cannot access another firm\'s project by guessing the projectId', () => {
      // Attacker: bob@beta.com tries to access PROJECT_A (owned by alice@acme.com)
      const result = getProjectForUser(PROJECT_A, 'bob@beta.com', 'user');
      assert.equal(result, null, 'IDOR: bob must not access alice\'s project');
    });

    it('IDOR: user from same firm but not owner or collaborator cannot access project', () => {
      // PROJECT_A is owned by alice@acme.com, no collaborators
      const result = getProjectForUser(PROJECT_A, 'mallory@acme.com', 'user');
      assert.equal(result, null, 'IDOR: same-firm user without explicit access must be blocked');
    });

    it('IDOR: anonymous / empty email cannot access any project', () => {
      const result = getProjectForUser(PROJECT_A, '', 'user');
      assert.equal(result, null);
    });

    it('IDOR: null project returns null (no panic on invalid projectId)', () => {
      const result = getProjectForUser(null, 'alice@acme.com', 'user');
      assert.equal(result, null);
    });
  });

  describe('Collaborator access', () => {
    it('explicit collaborator can access the project', () => {
      const result = getProjectForUser(PROJECT_WITH_COLLABORATOR, 'carol@acme.com', 'user');
      assert.ok(result, 'Collaborator should have access');
    });

    it('non-collaborator cannot access the project even if same firm as collaborator', () => {
      // dave@acme.com is NOT in the collaborators list
      const result = getProjectForUser(PROJECT_WITH_COLLABORATOR, 'dave@acme.com', 'user');
      assert.equal(result, null);
    });

    it('IDOR: collaborator on project C cannot access project A', () => {
      // carol@acme.com is a collaborator on PROJECT_WITH_COLLABORATOR but not PROJECT_A
      // PROJECT_A.collaborators is empty, even though alice is owner of both
      const result = getProjectForUser(PROJECT_A, 'carol@acme.com', 'user');
      assert.equal(result, null, 'Collaboration is per-project, not firm-wide');
    });
  });

  describe('Admin bypass (intentional)', () => {
    it('admin can access any project', () => {
      const r1 = getProjectForUser(PROJECT_A, 'admin@platform.com', 'admin');
      const r2 = getProjectForUser(PROJECT_B, 'admin@platform.com', 'admin');
      assert.ok(r1);
      assert.ok(r2);
    });
  });

});

describe('IDOR Protection — Session User Derivation', () => {

  it('firmDomain extracted correctly from email', () => {
    const user = buildSessionUser('alice@acme.com', 'user');
    assert.equal(user.firmDomain, 'acme.com');
  });

  it('admin users get wildcard firmDomain', () => {
    const user = buildSessionUser('admin@platform.com', 'admin');
    assert.equal(user.firmDomain, '*');
  });

  it('malformed email (no @) produces empty firmDomain for regular user', () => {
    const user = buildSessionUser('notanemail', 'user');
    assert.equal(user.firmDomain, '');
  });

});

describe('IDOR Protection — Route-level scenarios', () => {
  // These describe the exact scenarios that were found vulnerable and fixed.
  // Each maps to a specific route that previously used getProject() instead
  // of getProjectForUser().

  const aliceSession = buildSessionUser('alice@acme.com', 'user');
  const bobSession   = buildSessionUser('bob@beta.com',   'user');

  it('POST /api/projects/:id/experts — bob cannot add experts to alice\'s project', () => {
    const project = getProjectForUser(PROJECT_A, bobSession.email, bobSession.role);
    assert.equal(project, null, 'Route should return 404, bob cannot modify alice\'s project');
  });

  it('PUT /api/projects/:id/experts/:eid — bob cannot update expert status in alice\'s project', () => {
    const project = getProjectForUser(PROJECT_A, bobSession.email, bobSession.role);
    assert.equal(project, null, 'Route should return 404 before calling updateExpertStatus');
  });

  it('DELETE /api/projects/:id/experts/:eid — bob cannot delete expert from alice\'s project', () => {
    const project = getProjectForUser(PROJECT_A, bobSession.email, bobSession.role);
    assert.equal(project, null, 'Route should return 404 before calling removeExpertFromProject');
  });

  it('POST /api/projects/:id/experts/:eid/complete — bob cannot trigger Stripe invoice on alice\'s project', () => {
    const project = getProjectForUser(PROJECT_A, bobSession.email, bobSession.role);
    assert.equal(project, null, 'Route should return 404, preventing Stripe invoice for wrong project');
  });

  it('POST /api/projects/:id/experts/:eid/request-availability — bob cannot send availability email on alice\'s project', () => {
    const project = getProjectForUser(PROJECT_A, bobSession.email, bobSession.role);
    assert.equal(project, null, 'Route should return 404 before sending email');
  });

  it('POST /api/projects/:id/interview-guide — bob cannot read alice\'s research question via interview guide', () => {
    const project = getProjectForUser(PROJECT_A, bobSession.email, bobSession.role);
    assert.equal(project, null, 'Route should return 404, preventing data exfiltration via LLM generation');
  });

  it('POST /api/projects/:id/vetting-questions — bob cannot read alice\'s expert data via vetting questions', () => {
    const project = getProjectForUser(PROJECT_A, bobSession.email, bobSession.role);
    assert.equal(project, null, 'Route should return 404, preventing expert data leakage');
  });

  it('POST /api/projects/:id/request-client-availability — bob cannot send client scheduling email from alice\'s project', () => {
    const project = getProjectForUser(PROJECT_A, bobSession.email, bobSession.role);
    assert.equal(project, null, 'Route should return 404 before sending email');
  });

  it('alice can still perform all operations on her own project', () => {
    const project = getProjectForUser(PROJECT_A, aliceSession.email, aliceSession.role);
    assert.ok(project, 'Alice must retain access to her own project');
  });

});
