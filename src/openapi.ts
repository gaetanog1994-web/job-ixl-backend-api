import path from "node:path";
import { fileURLToPath } from "node:url";
import swaggerJsdoc from "swagger-jsdoc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function buildOpenApiSpec() {
    const definition = {
        openapi: "3.0.3",
        info: {
            title: "JIP Backend API",
            version: "1.0.0",
            description: "OpenAPI specification for Job Interlocking Platform backend.",
        },
        servers: [
            {
                url: process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3000",
                description: "Backend API server",
            },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: "http",
                    scheme: "bearer",
                    bearerFormat: "JWT",
                },
            },
            schemas: {
                ErrorResponse: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean", example: false },
                        error: {
                            oneOf: [
                                { type: "string" },
                                {
                                    type: "object",
                                    properties: {
                                        code: { type: "string" },
                                        message: { type: "string" },
                                    },
                                },
                            ],
                        },
                        correlationId: { type: "string", nullable: true },
                    },
                },
            },
        },
    };

    const options: swaggerJsdoc.Options = {
        definition,
        apis: [
            path.join(__dirname, "openapi.paths.ts"),
            path.join(__dirname, "openapi.paths.js"),
        ],
    };

    return swaggerJsdoc(options);
}
