const db = require("@saltcorn/data/db");
const { eval_expression } = require("@saltcorn/data/models/expression");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const Field = require("@saltcorn/data/models/field");
const Table = require("@saltcorn/data/models/table");
const { getState } = require("@saltcorn/data/db/state");
const { mkTable } = require("@saltcorn/markup");
const { pre, code } = require("@saltcorn/markup/tags");
const { createDAVClient } = require("tsdav");
const configuration_workflow = (cfg) => (req) =>
  new Workflow({
    steps: [
      {
        name: "query",
        form: async () => {
          const client = await getClient(cfg);
          const cals = await getCals(cfg, client);
          return new Form({
            fields: [
              {
                name: "calendar_url",
                label: "Calendar URL",
                type: "String",
                required: true,
                attributes: { options: cals.map((c) => c.url) },
              },
            ],
          });
        },
      },
    ],
  });

let _allCals;

const getClient = async ({ username, password, auth_method, url }) => {
  console.log("url", url);

  const client = await createDAVClient({
    serverUrl: url,
    credentials: {
      username,
      password,
    },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  return client;
};

const getCals = async (opts, client0) => {
  if (_allCals) return _allCals;
  const client = client0 || (await getClient(opts));
  const calendars = await client.fetchCalendars();
  _allCals = calendars;
  return calendars;
};

const runQuery = async (cfg, where, opts) => {
  const client = await getClient(cfg);
  const cals = await getCals(cfg, client);
  const calendar = cals.find((c) => c.url === cfg.calendar_url);
  console.log("calendar", calendar);

  const objects = await client.fetchCalendarObjects({
    calendar,
  });

  console.log(objects);

  /* const sqlQ = parser.sqlify(ast, opt);
  console.log({ sqlQ, phValues, opts });
  const qres = await client.query(sqlQ, phValues);
  qres.query = sqlQ;
  await client.query(`ROLLBACK;`);

  if (!is_sqlite) client.release(true);
  return qres;*/
  return [];
};

module.exports = (cfg) => ({
  CalDav: {
    configuration_workflow: configuration_workflow(cfg),
    fields: (cfg) => [{ name: "id", type: "Integer" }],
    get_table: (cfgTable) => {
      return {
        getRows: async (where, opts) => {
          const qres = await runQuery({ ...cfg, ...cfgTable }, where, opts);
          return qres;
        },
      };
    },
  },
});
