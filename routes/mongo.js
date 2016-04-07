
var mongodb = require('mongodb'),
    RJSON = require('relaxed-json'),
    format = require('util').format;

var MongoClient = mongodb.MongoClient;

var urlform =
{
	// user:pwd@host:port/db
	'DEFAULT': "mongodb://%s:%s@%s:%s/%s?authSource=%s", //authMechanism=DEFAULT&
	// user@host:port/db
	'MONGODB-X509': "mongodb://%s@%s:%s/%s?authMechanism=MONGODB-X509",
	// user:pwd@server/kerberos
	'GSSAPI': "mongodb://%s%s@%s/kerberos?authMechanism=GSSAPI&gssapiServiceName=mongodb",
	// user:pwd@server/db
	'PLAIN': "mongodb://%s:%s@%s?authMechanism=PLAIN",
	// host:port/db
	'NONE': "mongodb://%s:%s/%s"
}

function mongourl(host, port, db, cred, serveropts)
{
	if(!cred || !cred.authmech)
		return format(urlform['NONE'], host, port, db);

	var url = null;

	if(cred.pem)
	{
		serveropts.sslCert = cred.pemdata;
		serveropts.sslKey = cred.pemdata;
		serveropts.sslPass = cred.pempwd;
		serveropts.sslValidate = false;
	}

	host = (host || ''); port = (port || ''); db = (db || '');

	switch(cred.authmech)
	{
		case 'DEFAULT':
			url = format(urlform['DEFAULT'], cred.username, cred.password, host, port, db, (cred.authsrc || db));
			break;

		case 'MONGODB-X509':
			url = format(urlform['MONGODB-X509'], encodeURIComponent(cred.username), host, port, db);

			break;

		case 'GSSAPI':
			url = format(urlform['GSSAPI'], encodeURIComponent(creds.username), (creds.password ? ':' + creds.password : ''), creds.authsrc);

			break;

		case 'PLAIN':
			url = format(urlform['PLAIN'], creds.username, creds.password, creds.authsrc, db);
			break;
	}

	url += ('&ssl=' + (!!cred.pem));

	console.log(url);

	return url;
}

exports.namespaces =
	function(req, res)
	{
		var opts = { server : { poolSize : 1 } };

		var url = mongourl(req.param('host'), req.param('port'),
			(req.param('configdb') || 'config'), req.query, opts.server);

		MongoClient.connect(url, opts, function(err, db)
		{
			if (err)
				res.status(500).send(err);
			else
			{
				var chunkcoll = db.collection('chunks');

				chunkcoll.distinct('ns', function(err, namespaces)
				{
					if(err)
						res.status(500).send(err);
					else if(namespaces.length == 0)
						res.status(404).send( { message : "No sharded namespaces found; wrong config db name or no data" } );
					else
						res.json(namespaces);

					db.close();
				});
			}
		})
	};

exports.dbs =
	function(req, res)
	{
		var opts = { server : { poolSize : 1 } };

		var url = mongourl(req.param('host'),
			req.param('port'), null, req.query, opts.server);

		MongoClient.connect(url, opts, function (err, db)
		{
			if (err)
				res.status(500).send(err);
			else
			{
				db.admin().listDatabases(function(err, dbs)
				{
					if(err)
						res.status(500).send(err);
					else
						res.json(dbs);

					db.close();
				});
			}
		});
	};

exports.collections =
	function(req, res)
	{
		var opts = { server : { poolSize : 1 } };

		var url = mongourl(req.param('host'),
			req.param('port'), req.param('db'), req.query, opts.server);

		MongoClient.connect(url, opts, function (err, db)
		{
			if (err)
				res.status(500).send(err);
			else
			{
				db.listCollections().toArray(function(err, colls)
				{
					if(err)
						res.status(500).send(err);
					else
						res.json(colls);

					db.close();
				});
			}
		});
	};

exports.metadata =
	function(req, res)
	{
		var opts = { server : { poolSize : 1 } };

		var url = mongourl(req.param('host'), req.param('port'),
			(req.param('configdb') || 'config'), req.query, opts.server);

		var namespace = req.param('namespace');

		MongoClient.connect(url, opts, function (err, db)
		{
			if (err)
				res.status(500).send(err);
			else
			{
			    var collcoll = db.collection('collections');

			    var changecoll = db.collection('changelog');
				var chunkcoll = db.collection('chunks');

				var shardcoll = db.collection('shards');
				var tagcoll = db.collection('tags');

				// guard against collections that were dropped and recreated; only take changelog entries since the most recent sharding
				collcoll.find({ _id : namespace, dropped : false }).limit(1).toArray(function(err, shardevent)
				{
					var start = new Date(0);

					if(err)
					{
						res.status(500).send(err);
						db.close();

						return;
					}
					else if(shardevent && shardevent.length > 0)
						start = shardevent[0].lastmod;

					var changecursor = changecoll.find({ ns : namespace, what : /moveChunk|split/, time : { $gt : start } }).sort({ time : -1 });
					var chunkcursor = chunkcoll.find({ ns : namespace });

					var tagcursor = tagcoll.find({ ns : namespace });
					var shardcursor = shardcoll.find({});

					var collections = ['"changelog"', '"chunks"', '"shards"', '"tags"'];
					var cursors = [changecursor, chunkcursor, shardcursor, tagcursor];

					res.set('Content-Type', 'application/json');

					send(collections, cursors, res, 0);
				});
			}
		});

		// stream the full metadata object to client-side
		function send(collections, cursors, res, idx)
		{
			idx = (idx || 0);

			// open top-level document or separate from preceding array
			res.write((idx == 0) ? '{' : ',');

			// add collection key and open array, e.g. 'changelog' : [
			res.write(collections[idx] + " : [");

			var firstDoc = true;

			// write the contents of the array
			cursors[idx].stream().on("data", function(doc)
			{
				if(!firstDoc) res.write(','); else firstDoc = false;
				res.write(JSON.stringify(doc));
			});

			// end of cursor; close array, begin next or close top-level doc
			cursors[idx].stream().on("end", function()
			{
				res.write(']');

				if(idx+1 == cursors.length)
				{
					res.write('}');
					res.end();
				}
				else
					send(collections, cursors, res, idx+1);
			});

			cursors[idx].stream().on("error", function(err) { res.status(500).send(err); });
		}
	};

exports.query =
	function(req, res)
	{
		var opts = { server : { poolSize : 1 } };

		var url = mongourl(req.param('host'),
			req.param('port'), req.param('db'), req.query, opts.server);

		try
		{
			var query = RJSON.parse(req.param('query'));
		}
		catch(err)
		{
			res.status(500).json({ stack : err.stack, message : err.message });
			throw err;
		}

		var collection = req.param('collection');

		var result = [];

		MongoClient.connect(url, opts, function (err, db)
		{
			if (err)
				res.status(500).send(err);
			else
			{
				var coll = db.collection(collection);

				var stream = undefined;

				if(Array.isArray(query))
					stream = coll.aggregate(query).stream();
				else
					stream = coll.find(query).stream();

				stream.on("data", function(document) { result.push(document) });
			    stream.on("end", function(){ res.json(result); db.close(); });
			}
		});
	}