/**
 * Module dependencies
 */
var util = require('util');
var actionUtil = require('../actionUtil');
var _ = require('lodash');


/**
 * Add Record To Collection
 *
 * post  /:modelIdentity/:id/:collectionAttr/:childid
 *  *    /:modelIdentity/:id/:collectionAttr/add/:childid
 *
 * Associate one record with the collection attribute of another.
 * e.g. add a Horse named "Jimmy" to a Farm's "animals".
 * If the record being added has a primary key value already, it will
 * just be linked.  If it doesn't, a new record will be created, then
 * linked appropriately.  In either case, the association is bidirectional.
 *
 * @param {Integer|String} parentid  - the unique id of the parent record
 * @param {Integer|String} id    [optional]
 *        - the unique id of the child record to add
 *        Alternatively, an object WITHOUT a primary key may be POSTed
 *        to this endpoint to create a new child record, then associate
 *        it with the parent.
 *
 * @option {String} model  - the identity of the model
 * @option {String} alias  - the name of the association attribute (aka "alias")
 */

module.exports = function addToCollection (req, res) {

  // Ensure a model and alias can be deduced from the request.
  var Model = actionUtil.parseModel(req);
  var relation = req.options.alias;
  if (!relation) {
    return res.serverError(new Error('Missing required route option, `req.options.alias`.'));
  }

  var parentPk = req.param('parentid');
  var childPk = actionUtil.parsePk(req);

  // The child record to associate is defined by either...
  var child;

  // ...a primary key:
  if (childPk) {
    child = {};
    child['id'] = childPk;
  }
  // ...or an object of values:
  else {
    req.options.values = req.options.values || {};
    req.options.values.blacklist = req.options.values.blacklist || ['limit', 'skip', 'sort', 'id', 'parentid'];
    child = actionUtil.parseValues(req);
  }

  if (!child) {
    res.badRequest('You must specify the record to add (either the primary key of an existing record to link, or a new object without a primary key which will be used to create a record then link it.)');
  }



  async.auto({

    // Look up the parent record
    parent: function (cb) {
      Model.findOne(parentPk).exec(function foundParent(err, parentRecord) {
        if (err) return cb(err);
        if (!parentRecord) return cb({status: 404});
        if (!parentRecord[relation]) return cb({status: 404});
        cb(null, parentRecord);
      });
    },

    // If a primary key was specified in the `child` object we parsed
    // from the request, look it up to make sure it exists.  Send back its primary key value.
    // This is here because, although you can do this with `.save()`, you can't actually
    // get ahold of the created child record data, unless you create it first.
    child: ['parent', function(cb) {

      var association = _.findWhere(Model.associations, { alias: relation });
      var ChildModel = sails.models[association.collection];
      var criteria = {};
      if (child[ChildModel.primaryKey]) {
        criteria[ChildModel.primaryKey] = child[ChildModel.primaryKey];
      }
      // If no primary key is specified, look for
      else {
        criteria[ChildModel.primaryKey] = null;
      }
      ChildModel.findOrCreate(criteria, child).exec(function(err, childRecord) {
        if (err) return res.negotiate(err);
        return cb(null, childRecord[ChildModel.primaryKey]);
      });
    }],

    // Add the child record to the parent's collection
    add: ['parent', 'child', function(cb, async_data) {
      try {
        // `collection` is the parent record's collection we
        // want to add the child to.
        var collection = async_data.parent[relation];
        collection.add(child);
        return cb();
      }
      // Ignore `insert` errors
      catch (err) {
        if (err && err.type !== 'insert') {
          return cb(err);
        }
        else if (err) {
          // if we made it here, then this child record is already
          // associated with the collection.  But we do nothing:
          // `add` is idempotent.
        }

        return cb();
      }
    }]
  },

  // Save the parent record
  function readyToSave (err, async_data) {
    if (err) return res.negotiate(err);

    async_data.parent.save(function saved(err) {

      // Ignore `insert` errors for duplicate adds
      // (but keep in mind, we should not publishAdd if this is the case...)
      var isDuplicateInsertError = (err && typeof err === 'object' && err.length && err[0] && err[0].type === 'insert');
      if (err && !isDuplicateInsertError) return res.negotiate(err);

      // Only broadcast an update if this isn't a duplicate `add`
      // (otherwise connected clients will see duplicates)
      if (!isDuplicateInsertError && req._sails.hooks.pubsub) {

        // Subscribe to the model you're adding to, if this was a socket request
        if (req.isSocket) { Model.subscribe(req, async_data.parent); }

        // Publish to subscribed sockets
        console.log('\n************ publishAdd:\n',async_data.parent[Model.primaryKey], relation, async_data.child, !req.options.mirror && req,'\n---------------------');


        Model.publishAdd(async_data.parent[Model.primaryKey], relation, async_data.child, !req.options.mirror && req);
      }

      // Finally, look up the parent record again and populate the relevant collection.
      // TODO: populateEach
      Model.findOne(parentPk).populate(relation).exec(function(err, matchingRecord) {
        if (err) return res.serverError(err);
        if (!matchingRecord) return res.serverError();
        if (!matchingRecord[relation]) return res.serverError();
        return res.ok(matchingRecord);
      });
    });

  }); // </async.auto>
};