import express from "express";
import { join } from "path";
import logger from "morgan";
import passport from "passport";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import { AppConfig } from "./config";
import { PostgresState } from "./postgres-state";
import { persistResponses } from "./persistence-middleware";
import bodyParser from "body-parser";
import cors from "cors";
import paginate from "express-paginate";
import { createHandler as graphqlHandler } from "graphql-http/lib/use/express";
import { loadSchemaSync } from "@graphql-tools/load";
import { GraphQLFileLoader } from "@graphql-tools/graphql-file-loader";
import { addResolversToSchema } from "@graphql-tools/schema";

import auth from "./auth";
import userRoutes from "./user-routes";
import contactRoutes from "./contact-routes";
import bankAccountRoutes from "./bankaccount-routes";
import gqlPlaygroundRoutes from "./gql-playground-routes";
import transactionRoutes from "./transaction-routes";
import likeRoutes from "./like-routes";
import commentRoutes from "./comment-routes";
import notificationRoutes from "./notification-routes";
import bankTransferRoutes from "./banktransfer-routes";
import testDataRoutes from "./testdata-routes";
import { checkAuth0Jwt, verifyOktaToken, checkCognitoJwt, checkGoogleJwt } from "./helpers";
import resolvers from "./graphql/resolvers";
import { avatarRoutes } from "./avatar-routes";
import { avatarSession } from "./avatar-session";

const schema = loadSchemaSync(join(__dirname, "./graphql/schema.graphql"), {
  loaders: [new GraphQLFileLoader()],
});

const schemaWithResolvers = addResolversToSchema({
  schema,
  resolvers,
});

export function createApp(config: AppConfig, persistence?: { pool: Pool; state: PostgresState }) {
  const app = express();
  if (config.production) app.set("trust proxy", 1);
  app.get("/healthz", (_req, res) => res.json({ status: "ok", release: config.release }));
  app.get("/readyz", async (_req, res) => {
    try {
      if (persistence) await persistence.pool.query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  /* istanbul ignore next */
  // @ts-expect-error
  if (global.__coverage__) {
    require("@cypress/code-coverage/middleware/express")(app);
  }

  if (!config.production)
    app.use(cors({ origin: `http://localhost:${process.env.PORT || 3000}`, credentials: true }));
  if (config.production) {
    app.use((req, res, next) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("origin") !== config.origin) {
        res.status(403).json({ error: "Untrusted request origin" });
        return;
      }
      next();
    });
  }
  app.use(logger("dev"));
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());

  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      unset: "destroy",
      ...(persistence
        ? {
            store: new (connectPgSimple(session))({
              pool: persistence.pool,
              tableName: "rwa_sessions",
              createTableIfMissing: true,
              errorLog: () => console.error("Session store unavailable"),
            }),
          }
        : {}),
      cookie: { httpOnly: true, secure: config.production, sameSite: "lax" },
    })
  );
  app.use(passport.initialize());
  app.use(
    config.production ? "/api/avatars" : "/avatars",
    persistence ? avatarSession(persistence.state) : passport.session(),
    avatarRoutes(config.production ? "/api" : `http://localhost:${config.port}`)
  );
  const api = express.Router();
  if (persistence) api.use(persistResponses(persistence.state));
  api.use(passport.session());

  api.use(paginate.middleware(Number(process.env.PAGINATION_PAGE_SIZE || 10)));

  /* istanbul ignore next */
  if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") {
    api.use("/testData", testDataRoutes);
  }

  api.use(auth);

  /* istanbul ignore if */
  if (process.env.VITE_AUTH0) {
    api.use(checkAuth0Jwt);
  }

  /* istanbul ignore if */
  if (process.env.VITE_OKTA) {
    api.use(verifyOktaToken);
  }

  /* istanbul ignore if */
  if (process.env.VITE_AWS_COGNITO) {
    api.use(checkCognitoJwt);
  }

  /* istanbul ignore if */
  if (process.env.VITE_GOOGLE) {
    api.use(checkGoogleJwt);
  }

  if (!config.production)
    app.get("/", (req, res) => {
      res.send("Cypress Realworld App - backend");
    });
  if (!config.production) api.use("/graphql", gqlPlaygroundRoutes);
  api.use(
    "/graphql",
    graphqlHandler({
      schema: schemaWithResolvers,
      context: async (req, _args) => {
        return { user: req.raw.user };
      },
    })
  );
  api.use("/users", userRoutes);
  api.use("/contacts", contactRoutes);
  api.use("/bankAccounts", bankAccountRoutes);
  api.use("/transactions", transactionRoutes);
  api.use("/likes", likeRoutes);
  api.use("/comments", commentRoutes);
  api.use("/notifications", notificationRoutes);
  api.use("/bankTransfers", bankTransferRoutes);
  api.use((_req, res) => res.status(404).json({ error: "API route not found" }));
  app.use(config.production ? "/api" : "/", api);
  if (config.production) {
    app.use(["/testData", "/api"], (_req, res) => res.status(404).json({ error: "Not found" }));
    const client = join(__dirname, "../../client");
    app.use(express.static(client));
    app.get("*", (_req, res) => res.sendFile(join(client, "index.html")));
  } else {
    app.use(express.static(join(__dirname, "../public")));
  }
  app.use(((error: any, _req: any, res: any, _next: any) => {
    console.error("Request failed");
    res.status(500).json({ error: "Request failed" });
  }) as express.ErrorRequestHandler);
  return app;
}
