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

const configuration_workflow = (req) =>
  new Workflow({
    steps: [
      {
        name: "query",
        form: async () => {
          return new Form({
            fields: [
              {
                name: "calendar_url",
                label: "Calendar URL",
                type: "String",
                required: true,
              },
            ],
          });
        },
      },
    ],
  });

const runQuery = async (cfg, where, opts) => {
  /* const sqlQ = parser.sqlify(ast, opt);
  console.log({ sqlQ, phValues, opts });
  const qres = await client.query(sqlQ, phValues);
  qres.query = sqlQ;
  await client.query(`ROLLBACK;`);

  if (!is_sqlite) client.release(true);
  return qres;*/
  return [];
};

module.exports = {
  "SQL query": {
    configuration_workflow,
    fields: (cfg) => cfg?.columns || [],
    get_table: (cfg) => {
      return {
        getRows: async (where, opts) => {
          const qres = await runQuery(cfg, where, opts);
          return qres;
        },
      };
    },
  },
};
