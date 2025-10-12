const db = require("@saltcorn/data/db");
const Table = require("@saltcorn/data/models/table");
const File = require("@saltcorn/data/models/file");
const User = require("@saltcorn/data/models/user");
const Crash = require("@saltcorn/data/models/crash");
const Trigger = require("@saltcorn/data/models/trigger");
const Plugin = require("@saltcorn/data/models/plugin");
const { getState } = require("@saltcorn/data/db/state");
const {
  getClient,
  getCals,
  getEnd,
  allDayDuration,
  includeCalendar,
  getTimeRange,
  createKeyCache,
  runQuery,
} = require("./common");

const objMap = (obj, f) => {
  const result = {};
  Object.keys(obj).forEach((k) => {
    result[k] = f(obj[k]);
  });
  return result;
};

const buildEventLookup = async (table, { calendar_url_field }) => {
  const allEvents = await table.getRows({});
  const lookup = {};
  for (const event of allEvents) {
    if (!lookup[event[calendar_url_field]])
      lookup[event[calendar_url_field]] = [];
    lookup[event[calendar_url_field]].push(event);
  }
  return lookup;
};

const getSyncInfos = async (cfg) => {
  const {
    calendar_info_table,
    sync_token_field,
    ctag_field,
    calendar_info_url_field,
  } = cfg;
  const table = Table.findOne({ name: calendar_info_table });
  const existing = await table.getRows({});
  const result = {};
  for (const e of existing) {
    const calUrl = e[calendar_info_url_field];
    if (!calUrl || !cfg[`cal_${encodeURIComponent(calUrl)}`]) continue;
    result[e[calendar_info_url_field]] = {
      syncToken: e[sync_token_field],
      ctag: e[ctag_field],
    };
  }
  return result;
};

const updateSyncInfos = async (
  table,
  cal_url,
  { sync_token_field, ctag_field, calendar_info_url_field },
  syncData,
) => {
  const existing = await table.getRow({ [calendar_info_url_field]: cal_url });
  if (existing) {
    const upd = {};
    upd[sync_token_field] = syncData.syncToken;
    upd[ctag_field] = syncData.ctag;
    await table.updateRow(upd, existing[table.pk_name]);
  }
};

const deleteUnsyncedCalendars = async (
  destTbl,
  eventLookup,
  calFlags,
  { calendar_url_field },
) => {
  const lookupKeys = Object.keys(eventLookup);
  for (const url of lookupKeys) {
    const cfgUrl = `cal_${encodeURIComponent(url)}`;
    if (calFlags[cfgUrl]) continue;
    getState().log(5, `Deleting events for unsynced calendar ${url}`);
    await destTbl.deleteRows({
      [calendar_url_field]: url,
    });
  }
};

const fullSync = async (calendarUrl, syncData, eventLookup, configuration) => {
  const {
    table_dest,
    url_field,
    summary_field,
    start_field,
    end_field,
    location_field,
    calendar_url_field,
    description_field,
    categories_field,
    all_day_field,
    etag_field,
    rrule_field,
    uid_field,
  } = configuration;
  const table = Table.findOne({ name: table_dest });
  const existing = eventLookup[calendarUrl] || [];
  const existingETags = new Set(
    existing.map(
      (e) =>
        // we need all three because we want duplication of events with multiple participants
        e[calendar_url_field] + "///" + e[url_field] + "///" + e[etag_field],
    ),
  );
  const deleteEtags = new Set(existingETags);
  for (const event of syncData.created) {
    const tag = event.calendar_url + "///" + event.url + "///" + event.etag;
    deleteEtags.delete(tag);
    if (existingETags.has(tag)) continue;
    // insert or update
    const row = {
      [url_field]: event.url,
      [summary_field]: event.summary,
      [start_field]: event.start,
      [end_field]: event.end,
      [location_field]: event.location,
      [description_field]: event.description,
      [categories_field]: event.categories,
      [calendar_url_field]: event.calendar_url,
      [etag_field]: event.etag,
      [all_day_field]: event.all_day,
    };
    if (rrule_field) row[rrule_field] = event.rrule;
    if (uid_field) row[uid_field] = event.uid;
    const existingEvent = await table.getRow({ [url_field]: event.url });
    if (existingEvent) {
      if (Object.keys(row).filter((k) => row[k] !== existingEvent[k]).length)
        await table.updateRow(row, existingEvent[table.pk_name]);
    } else await table.insertRow(row);
  }
  for (const delTag of [...deleteEtags]) {
    const [cal_url, del_url, del_etag] = delTag.split("///");
    await table.deleteRows({
      [calendar_url_field]: cal_url,
      [etag_field]: del_etag,
      [url_field]: del_url,
    });
  }
};

/**
 * handle creates, updates, deletes
 * @param {*} syncData
 * @param {*} configuration
 */
const incrementalSync = async (
  calendarUrl,
  syncData,
  eventLookup,
  configuration,
) => {
  const {
    table_dest,
    url_field,
    summary_field,
    start_field,
    end_field,
    location_field,
    calendar_url_field,
    description_field,
    categories_field,
    all_day_field,
    etag_field,
    rrule_field,
    uid_field,
  } = configuration;
  const destTbl = Table.findOne({ name: table_dest });

  const existing = eventLookup[calendarUrl] || [];
  const existingETags = new Set(
    existing.map(
      (e) =>
        // we need all three because we want duplication of events with multiple participants
        e[calendar_url_field] + "///" + e[url_field] + "///" + e[etag_field],
    ),
  );

  // new inserts
  for (const created of syncData.created) {
    if (
      existingETags.has(
        created.calendar_url + "///" + created.url + "///" + created.etag,
      )
    )
      continue;
    const row = {
      [url_field]: created.url,
      [summary_field]: created.summary,
      [start_field]: created.start,
      [end_field]: created.end,
      [location_field]: created.location,
      [description_field]: created.description,
      [categories_field]: created.categories,
      [calendar_url_field]: created.calendar_url,
      [etag_field]: created.etag,
      [all_day_field]: created.all_day,
    };
    if (rrule_field) row[rrule_field] = created.rrule;
    if (uid_field) row[uid_field] = created.uid;
    await destTbl.insertRow(row);
  }

  // new updates
  for (const updated of syncData.updated) {
    const existingEvent = await destTbl.getRow({ [url_field]: updated.url });
    if (existingEvent) {
      if (Object.keys(row).filter((k) => row[k] !== existingEvent[k]).length)
        await destTbl.updateRow(row, existingEvent[destTbl.pk_name]);
    }
  }

  // new deletes
  for (const deleted of syncData.deleted) {
    await destTbl.deleteRows({
      [calendar_url_field]: deleted.calendar_url,
      [etag_field]: deleted.etag,
      [url_field]: deleted.url,
    });
  }
};

module.exports = (cfg) => ({
  configFields: async () => {
    const tables = await Table.find();
    const tableMap = {};
    tables.forEach((t) => (tableMap[t.name] = t));

    const strOptFields = objMap(tableMap, (table) => [
      "",
      ...table.fields
        .filter((f) => f.type?.name === "String")
        .map((f) => f.name),
    ]);
    const strFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => f.type?.name === "String").map((f) => f.name),
    );

    const dateFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => f.type?.name === "Date").map((f) => f.name),
    );
    const boolFields = objMap(tableMap, (table) =>
      table.fields.filter((f) => f.type?.name === "Bool").map((f) => f.name),
    );
    const triggers = await Trigger.find({});
    const client = await getClient(cfg);
    const cals = await getCals(cfg, client);

    return [
      ...cals.map((c) => ({
        name: `cal_${encodeURIComponent(c.url)}`,
        label: c.displayName,
        sublabel: c.url,
        type: "Bool",
      })),
      {
        name: "table_dest",
        label: "Destination table",
        sublabel: "Table to sync to",
        input_type: "select",
        required: true,
        options: tables.map((t) => t.name),
      },
      {
        name: "url_field",
        label: "Event URL field",
        type: "String",
        required: true,
        attributes: {
          calcOptions: ["table_dest", strFields],
        },
      },
      {
        name: "uid_field",
        label: "UID field",
        type: "String",
        required: true,
        attributes: {
          calcOptions: ["table_dest", strFields],
        },
      },
      {
        name: "summary_field",
        label: "Summary field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strFields],
        },
      },
      {
        name: "start_field",
        label: "Start field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", dateFields],
        },
      },
      {
        name: "end_field",
        label: "End field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", dateFields],
        },
      },

      {
        name: "location_field",
        label: "Location field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strOptFields],
        },
      },
      {
        name: "calendar_url_field",
        label: "Calendar URL field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strOptFields],
        },
      },
      {
        name: "description_field",
        label: "Description field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strOptFields],
        },
      },
      {
        name: "categories_field",
        label: "Categories field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strOptFields],
        },
      },
      {
        name: "etag_field",
        label: "E-Tag field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strFields],
        },
      },
      {
        name: "rrule_field",
        label: "Recurrence rule field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", strOptFields],
        },
      },
      {
        name: "all_day_field",
        label: "All day field",
        type: "String",
        attributes: {
          calcOptions: ["table_dest", boolFields],
        },
      },
      {
        name: "error_action",
        label: "Error action",
        sublabel: "Run this action when there is an error processing calendars",
        type: "String",
        attributes: {
          options: triggers.map((tr) => tr.name),
        },
      },
      {
        name: "calendar_info_table",
        label: "Calendar info table",
        sublabel: "Table with calendar info such as sync token and ctag",
        input_type: "select",
        options: tables.map((t) => t.name),
      },
      {
        name: "sync_token_field",
        label: "Sync token field",
        type: "String",
        attributes: {
          calcOptions: ["calendar_info_table", strOptFields],
        },
      },
      {
        name: "ctag_field",
        label: "Ctag field",
        type: "String",
        attributes: {
          calcOptions: ["calendar_info_table", strOptFields],
        },
      },
      {
        name: "calendar_info_url_field",
        label: "Calendar info URL field",
        type: "String",
        attributes: {
          calcOptions: ["calendar_info_table", strOptFields],
        },
      },
    ];
  },
  disableInBuilder: true,
  disableInList: true,

  run: async ({ row, configuration, req }) => {
    const {
      table_dest,
      calendar_info_table,
      sync_token_field,
      ctag_field,
      calendar_info_url_field,
      url_field,
      summary_field,
      start_field,
      end_field,
      location_field,
      calendar_url_field,
      description_field,
      categories_field,
      all_day_field,
      etag_field,
      rrule_field,
      error_action,
      uid_field,
      ...calFlags
    } = configuration;
    const destTbl = Table.findOne({ name: table_dest });
    const infoTbl = Table.findOne({ name: calendar_info_table });
    const syncInfos = await getSyncInfos({
      calendar_info_table,
      sync_token_field,
      ctag_field,
      calendar_info_url_field,
      ...calFlags,
    });
    const eventLookup = await buildEventLookup(destTbl, configuration);
    await deleteUnsyncedCalendars(
      destTbl,
      eventLookup,
      calFlags,
      configuration,
    );
    const syncResult = await runQuery(
      { ...calFlags, ...cfg },
      {},
      { syncInfos, eventLookup },
    );
    const entries = Object.entries(syncResult);
    getState().log(5, `Syncing ${entries.length} calendars`);
    for (const [calendarUrl, syncData] of entries) {
      if (syncData.fullSync) {
        getState().log(
          5,
          `Full sync for ${calendarUrl} (${syncData.created.length} events)`,
        );
        await fullSync(calendarUrl, syncData, eventLookup, configuration);
      } else {
        getState().log(
          5,
          `Incremental sync for ${calendarUrl} (${syncData.created.length} created, ${syncData.updated.length} updated, ${syncData.deleted.length} deleted)`,
        );
        await incrementalSync(
          calendarUrl,
          syncData,
          eventLookup,
          configuration,
        );
      }
      await updateSyncInfos(infoTbl, calendarUrl, configuration, syncData);
    }
  },
});
