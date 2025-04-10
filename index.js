const db = require("@saltcorn/data/db");
const Form = require("@saltcorn/data/models/form");
const Field = require("@saltcorn/data/models/field");
const Table = require("@saltcorn/data/models/table");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const Workflow = require("@saltcorn/data/models/workflow");
const { eval_expression } = require("@saltcorn/data/models/expression");
const {
  text,
  div,
  h5,
  style,
  a,
  script,
  pre,
  domReady,
  i,
  text_attr,
} = require("@saltcorn/markup/tags");
const { mkTable } = require("@saltcorn/markup");
const { readState } = require("@saltcorn/data/plugin-helper");

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "views",
        form: async (context) => {
          return new Form({
            fields: [
              {
                name: "url",
                label: "URL",
                type: "String",
                required: true,
                sublabel: "CalDav server URL",
              },
              {
                name: "username",
                label: "User name",
                type: "String",
              },
              {
                name: "password",
                label: "Password",
                input_type: "password",
              },
              {
                name: "auth_method",
                label: "Auth method",
                type: "String",
                required: true,
                attributes: { options: ["Basic", "OAuth"] },
              },
            ],
          });
        },
      },
    ],
  });

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "caldav",
  configuration_workflow,
  table_providers: require("./table-provider.js"),
};
