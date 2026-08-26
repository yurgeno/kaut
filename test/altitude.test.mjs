import assert from 'node:assert/strict'
import { test } from 'node:test'
import { altitudeFor, altitudeDirective, BANDS } from '../lib/altitude.mjs'
import { renderLookup } from '../lib/lookup.mjs'

test('band table — layer-primary, repo-span tie-breaker within coarse layers', () => {
    // coarse layer (contracts/flows/map) + ≥2 distinct repos ⇒ landscape
    assert.equal(altitudeFor({ id: 'flows/x', sources: ['repo:a:file:p', 'repo:b:file:q'] }).band, BANDS.LANDSCAPE)
    assert.equal(altitudeFor({ id: 'map/services', sources: ['repo:a:file:p', 'repo:b:file:q'] }).band, BANDS.LANDSCAPE)
    // coarse layer + a single repo ⇒ component (not landscape)
    assert.equal(altitudeFor({ id: 'flows/x', sources: ['repo:a:file:p', 'user:owner'] }).band, BANDS.COMPONENT)
    assert.equal(altitudeFor({ id: 'contracts/x', sources: [] }).band, BANDS.COMPONENT)
    // fine layer (domains/runbook): single pinpoint file, no glob ⇒ endpoint
    assert.equal(altitudeFor({ id: 'domains/permissions', sources: ['file:src/permissionsService.ts'] }).band, BANDS.ENDPOINT)
    assert.equal(altitudeFor({ id: 'runbook/x', sources: ['file:a.ts', 'file:b.ts'] }).band, BANDS.ENDPOINT)
    // fine layer with >2 pinpoint files ⇒ component (not endpoint-precise)
    assert.equal(altitudeFor({ id: 'domains/y', sources: ['file:a', 'file:b', 'file:c'] }).band, BANDS.COMPONENT)
    // meta layers ⇒ component
    assert.equal(altitudeFor({ id: 'decisions/x', sources: ['repo:a:file:p', 'repo:b:file:q'] }).band, BANDS.COMPONENT)
    assert.equal(altitudeFor({ id: 'bootstrap/plan', sources: [] }).band, BANDS.COMPONENT)
})

test('Q2 fixture — contracts/frontend-bridge across 3 repos ⇒ landscape + confirm directive', () => {
    const alt = altitudeFor({
        id: 'contracts/frontend-bridge',
        sources: [
            'repo:demo-bridge:file:openapi/api-v1.yaml',
            'repo:gateway-service:file:config/application.yml',
            'repo:demo-repo:file:src/stores/reservationDetailStore.ts',
            'user:owner',
        ],
    })
    assert.equal(alt.band, BANDS.LANDSCAPE)
    assert.equal(alt.distinctRepos, 3)
    assert.equal(alt.confirmDirective, true)
    assert.match(altitudeDirective(alt), /confirm them against code \(§4\.2\)/)
})

test('false-positive guard — a fine-layer entity-map spanning repos via globs stays component', () => {
    // booking/domains/entity-map shape: file-globs + a cross-repo db-migration check.
    // The naive "≥2 repos ⇒ landscape" would mis-fire; layer-primary keeps it component.
    const alt = altitudeFor({
        id: 'domains/entity-map',
        sources: ['file-glob:src/**/entity/*.java', 'repo:db-migration:file:migrations/v1.sql'],
    })
    assert.equal(alt.band, BANDS.COMPONENT)
    assert.equal(alt.confirmDirective, false)
    assert.equal(altitudeDirective(alt), null)
})

test('altitudeDirective is null for every non-landscape band (silent in text)', () => {
    assert.equal(altitudeDirective(altitudeFor({ id: 'domains/permissions', sources: ['file:x.ts'] })), null)
    assert.equal(altitudeDirective(altitudeFor({ id: 'bootstrap/plan', sources: [] })), null)
})

test('renderLookup — a landscape doc gets the scope directive line under meta', () => {
    const doc = {
        id: 'contracts/frontend-bridge',
        fields: {
            trust: 'T1',
            derived_from_commit: 'abcdef012345',
            sources: ['repo:a:file:p', 'repo:b:file:q'],
        },
        body: '## Pointers\n\n- a\n',
    }
    const out = renderLookup(doc, { verdict: 'healthy', affected: [], notes: [] })
    assert.equal(
        out,
        '# kaut: contracts/frontend-bridge\n' +
            'trust: T1 (mechanical) · derived: abcdef012345 · healthy\n' +
            "altitude: landscape (cross-repo overview · 2 repos) — endpoint-level specifics are below this doc's resolution; confirm them against code (§4.2)\n" +
            '\n' +
            '## Pointers\n\n- a\n',
    )
})

test('renderLookup — a non-landscape doc renders byte-identically to before (no altitude line)', () => {
    const doc = {
        id: 'domains/routing',
        fields: { trust: 'T1', derived_from_commit: 'd638a6e7f7306908', sources: ['file:src/router/routes.ts'] },
        body: '## Pointers\n\n- a\n',
    }
    const out = renderLookup(doc, { verdict: 'healthy', affected: [], notes: [] })
    assert.equal(
        out,
        '# kaut: domains/routing\n' +
            'trust: T1 (mechanical) · derived: d638a6e7f730 · healthy\n' +
            '\n' +
            '## Pointers\n\n- a\n',
    )
})
