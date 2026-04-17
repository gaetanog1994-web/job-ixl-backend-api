/**
 * @openapi
 * /health:
 *   get:
 *     tags: [System]
 *     summary: Healthcheck backend
 *     responses:
 *       200:
 *         description: Service healthy
 *
 * /api/users/me/ensure:
 *   post:
 *     tags: [Users]
 *     summary: Create or update authenticated user profile row
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [full_name]
 *             properties:
 *               full_name: { type: string }
 *               first_name: { type: string, nullable: true }
 *               last_name: { type: string, nullable: true }
 *               location_id: { type: string, format: uuid, nullable: true }
 *     responses:
 *       200: { description: Profile ensured }
 *
 * /api/users/me:
 *   get:
 *     tags: [Users]
 *     summary: Get authenticated user profile
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: User profile }
 *
 * /api/users/me/applications:
 *   get:
 *     tags: [Users]
 *     summary: Get authenticated user applications
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Applications list }
 *
 * /api/users/me/activate:
 *   post:
 *     tags: [Users]
 *     summary: Activate authenticated user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: User activated }
 *
 * /api/users/me/deactivate:
 *   post:
 *     tags: [Users]
 *     summary: Deactivate authenticated user and cleanup applications
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: User deactivated }
 *
 * /api/users/{userId}/reorder-applications:
 *   post:
 *     tags: [Users]
 *     summary: Reorder user applications priorities
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [updates]
 *             properties:
 *               updates:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [app_ids, priority]
 *                   properties:
 *                     app_ids:
 *                       type: array
 *                       items: { type: string, format: uuid }
 *                     priority: { type: integer }
 *     responses:
 *       200: { description: Reorder applied }
 *
 * /api/map/positions:
 *   get:
 *     tags: [Map]
 *     summary: Fetch map payload with locations, roles and application state
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: viewerUserId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: mode
 *         schema: { type: string, enum: [from, to] }
 *     responses:
 *       200: { description: Map payload }
 *
 * /api/platform/companies:
 *   get:
 *     tags: [Platform]
 *     summary: List companies visible to current actor
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Companies list }
 *   post:
 *     tags: [Platform]
 *     summary: Create company with first super admin (owner only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Company created }
 *
 * /api/platform/companies/{companyId}:
 *   patch:
 *     tags: [Platform]
 *     summary: Rename company
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: companyId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Company updated }
 *
 * /api/platform/companies/{companyId}/perimeters:
 *   get:
 *     tags: [Platform]
 *     summary: List perimeters for a company
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: companyId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Perimeters list }
 *   post:
 *     tags: [Platform]
 *     summary: Create perimeter inside a company
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: companyId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201: { description: Perimeter created }
 *
 * /api/platform/companies/{companyId}/perimeters/{perimeterId}:
 *   patch:
 *     tags: [Platform]
 *     summary: Update perimeter metadata
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: companyId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: perimeterId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Perimeter updated }
 *
 * /api/platform/companies/{companyId}/super-admins:
 *   get:
 *     tags: [Platform]
 *     summary: List company super admins
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: companyId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Super admins list }
 *   post:
 *     tags: [Platform]
 *     summary: Add company super admin
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: companyId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201: { description: Super admin added }
 *
 * /api/platform/companies/{companyId}/super-admins/{userId}:
 *   delete:
 *     tags: [Platform]
 *     summary: Remove company super admin
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: companyId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Super admin removed }
 *
 * /api/platform/companies/{companyId}/perimeters/{perimeterId}/admins:
 *   get:
 *     tags: [Platform]
 *     summary: List perimeter admins
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: companyId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: perimeterId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Perimeter admins list }
 *   post:
 *     tags: [Platform]
 *     summary: Add perimeter admin
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: companyId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: perimeterId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201: { description: Perimeter admin added }
 *
 * /api/platform/companies/{companyId}/perimeters/{perimeterId}/admins/{userId}:
 *   delete:
 *     tags: [Platform]
 *     summary: Remove perimeter admin
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: companyId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: perimeterId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Perimeter admin removed }
 *
 * /api/admin/gdpr/tenant:
 *   delete:
 *     tags: [Admin]
 *     summary: Delete all scoped tenant data
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Tenant data deleted }
 *
 * /api/admin/gdpr/tenant/export:
 *   get:
 *     tags: [Admin]
 *     summary: Export all scoped tenant data
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: JSON export payload }
 *
 * /api/admin/gdpr/users/{userId}:
 *   delete:
 *     tags: [Admin]
 *     summary: Anonymize/deactivate a user (GDPR request)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: User anonymized/deactivated }
 *
 * /api/admin/campaign-status:
 *   get:
 *     tags: [Admin]
 *     summary: Get perimeter campaign status
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Campaign status }
 *   patch:
 *     tags: [Admin]
 *     summary: Update perimeter campaign status
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Campaign status updated }
 *
 * /api/admin/candidatures:
 *   get:
 *     tags: [Admin]
 *     summary: List scoped candidatures
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Candidatures list }
 *
 * /api/admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: List scoped users
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Users list }
 *   post:
 *     tags: [Admin]
 *     summary: Create user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: User created }
 *
 * /api/admin/users/active:
 *   get:
 *     tags: [Admin]
 *     summary: List active users in perimeter
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Active users list }
 *
 * /api/admin/users/{id}:
 *   patch:
 *     tags: [Admin]
 *     summary: Update user attributes
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: User updated }
 *   delete:
 *     tags: [Admin]
 *     summary: Delete user
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: User deleted }
 *
 * /api/admin/positions:
 *   get:
 *     tags: [Admin]
 *     summary: List scoped positions
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Positions list }
 *
 * /api/admin/config:
 *   get:
 *     tags: [Admin]
 *     summary: Get current app config
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Config payload }
 *
 * /api/admin/config/max-applications:
 *   post:
 *     tags: [Admin]
 *     summary: Update max applications and rebalance
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Config updated }
 *
 * /api/admin/locations:
 *   get:
 *     tags: [Admin]
 *     summary: List locations
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Locations list }
 *   post:
 *     tags: [Admin]
 *     summary: Create location
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Location created }
 *
 * /api/admin/locations/{id}:
 *   delete:
 *     tags: [Admin]
 *     summary: Delete location
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Location deleted }
 *
 * /api/admin/roles:
 *   get:
 *     tags: [Admin]
 *     summary: List roles
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Roles list }
 *   post:
 *     tags: [Admin]
 *     summary: Create role
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Role created }
 *
 * /api/admin/roles/{id}:
 *   delete:
 *     tags: [Admin]
 *     summary: Delete role
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Role deleted }
 *
 * /api/admin/interlocking-scenarios:
 *   get:
 *     tags: [Admin]
 *     summary: List stored interlocking scenarios
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Scenarios list }
 *   post:
 *     tags: [Admin]
 *     summary: Save interlocking scenario
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Scenario saved }
 *   delete:
 *     tags: [Admin]
 *     summary: Delete all interlocking scenarios in scope
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Scenarios deleted }
 *
 * /api/admin/interlocking-scenarios/export.csv:
 *   get:
 *     tags: [Admin]
 *     summary: Export interlocking scenarios CSV
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: CSV export }
 *
 * /api/admin/graph/chains:
 *   post:
 *     tags: [Admin Graph]
 *     summary: Compute chains through Neo4j graph proxy (tenant-scoped)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Chains computed }
 *
 * /api/admin/graph/warmup:
 *   post:
 *     tags: [Admin Graph]
 *     summary: Trigger Neo4j warmup through graph proxy
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Warmup acknowledged }
 *       503: { description: Neo4j sleeping/warming up }
 *
 * /api/admin/graph/summary:
 *   post:
 *     tags: [Admin Graph]
 *     summary: Fetch graph summary through graph proxy
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Graph summary }
 *
 * /api/admin/sync-graph:
 *   post:
 *     tags: [Admin Graph]
 *     summary: Rebuild graph from Supabase source of truth
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Graph rebuild completed }
 */
export const OPENAPI_PATHS_ANCHOR = true;
