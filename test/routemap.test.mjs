import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRouterPath, parseRoutes, RouteMapError, renderRoutesDoc } from '../lib/routemap.mjs'
import { validateDoc } from '../lib/indexgen.mjs'

const CONSTANTS = `
const ROUTER_PATH = {
    Home: {
        Path: '/home',
        Page: 'home',
        Title: 'Home',
    },
    Search: {
        Path: '/search',
        Page: 'SearchPage',
        Title: 'Search',
    },
    Detail: {
        Path: '/detail',
        Page: 'detail',
        Title: 'Detail',
    },
    DetailChild: {
        Path: 'child',
        Page: 'detailChild',
        Title: 'Child',
    },
}
const OTHER = { foo: 1 }
export { ROUTER_PATH }
`

const ROUTES = `
import { ROUTER_PATH } from '@packages/core/utils'
import { HomeView } from '@packages/booking_booking/views'

const ROOT = '/'

// guard helper BELOW has a path: decoy that must NOT be counted as a route
const guard = (to, next) => next({ path: to.fullPath })
const searchGuard = createFeatureGuard('X', ROUTER_PATH.Home.Path)

export default [
    {
        path: ROOT,
        redirect: ROUTER_PATH.Home.Path,
    },
    {
        path: ROUTER_PATH.Home.Path,
        name: ROUTER_PATH.Home.Page,
        component: HomeView,
        meta: { title: ROUTER_PATH.Home.Title },
    },
    {
        path: ROUTER_PATH.Search.Path,
        name: ROUTER_PATH.Search.Page,
        meta: { title: ROUTER_PATH.Search.Title },
        component: () => import('@packages/search_core/views').then((module) => module.SearchPage),
        beforeEnter: searchGuard,
    },
    {
        path: ROUTER_PATH.Detail.Path,
        component: () => import('@packages/booking_reservationDetail/views').then((module) => module.DetailView),
        children: [
            {
                path: ROUTER_PATH.DetailChild.Path,
                name: ROUTER_PATH.DetailChild.Page,
                meta: { title: ROUTER_PATH.DetailChild.Title },
                component: () => import('@packages/booking_reservationDetail/views').then((module) => module.DetailChildView),
            },
        ],
    },
]
`

test('parseRouterPath extracts only the ROUTER_PATH object', () => {
    const map = parseRouterPath(CONSTANTS)
    assert.equal(map.size, 4)
    assert.deepEqual(map.get('Search'), { Path: '/search', Page: 'SearchPage', Title: 'Search' })
    assert.ok(!map.has('foo')) // the unrelated OTHER object is ignored
})

test('parseRoutes resolves paths, views, packages, guards, and flattens children', () => {
    const { routes, total } = parseRoutes(ROUTES, CONSTANTS)
    assert.equal(total, 5) // the next({ path: ... }) decoy above the array is excluded
    assert.deepEqual(routes, [
        { path: '/', name: '', view: '(redirect)', pkg: '', guard: '' },
        { path: '/home', name: 'home', view: 'HomeView', pkg: 'booking_booking', guard: '' },
        { path: '/search', name: 'SearchPage', view: 'SearchPage', pkg: 'search_core', guard: 'searchGuard' },
        { path: '/detail', name: '', view: 'DetailView', pkg: 'booking_reservationDetail', guard: '' },
        { path: '/detail/child', name: 'detailChild', view: 'DetailChildView', pkg: 'booking_reservationDetail', guard: '' },
    ])
})

test('self-check throws when a path cannot be resolved (no partial map)', () => {
    const bad = `
export default [
    {
        path: ROUTER_PATH.Home.Path,
        name: ROUTER_PATH.Home.Page,
        component: HomeView,
    },
    {
        path: dynamicComputedPath,
        component: HomeView,
    },
]
`
    assert.throws(() => parseRoutes(bad, CONSTANTS), RouteMapError)
})

test('rendered map/routes.md is contract-valid', () => {
    const { routes } = parseRoutes(ROUTES, CONSTANTS)
    const content = renderRoutesDoc(routes, { derived: 'a'.repeat(40), harvested: '2026-06-11', version: '0.2.0' })
    const v = validateDoc('map/routes.md', content)
    assert.ok(v.ok, v.ok ? '' : JSON.stringify(v.errors))
    assert.ok(content.includes('| /detail/child | detailChild | DetailChildView | booking_reservationDetail |  |'))
    assert.ok(content.includes('engine: route-map@0.2.0'))
})
