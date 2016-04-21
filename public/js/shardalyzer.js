
var	OP_SPLIT = "split", OP_MULTI_SPLIT = "multi-split",
	OP_START = "moveChunk.start", OP_TO = "moveChunk.to",
	OP_COMMIT = "moveChunk.commit", OP_FROM = "moveChunk.from";

var	SOURCE = ".source", DESTINATION = ".dest",
	SUCCESS = ".success", FAILURE = ".fail";

var	STATUS_START_SOURCE = OP_START + SOURCE, STATUS_START_DEST = OP_START + DESTINATION,
	STATUS_TO_SOURCE = OP_TO + SOURCE, STATUS_TO_DEST = OP_TO + DESTINATION,
	STATUS_FROM_SUCCESS = OP_FROM + SUCCESS, STATUS_FROM_FAILURE = OP_FROM + FAILURE,
	STATUS_COMMIT = OP_COMMIT;

var	STATUS_SPLIT_SOURCE = OP_SPLIT + SOURCE, STATUS_SPLIT_DEST = OP_SPLIT + DESTINATION,
	STATUS_MULTI_SPLIT_SOURCE = OP_MULTI_SPLIT + SOURCE,
	STATUS_MULTI_SPLIT_DEST = OP_MULTI_SPLIT + DESTINATION;

var BALANCER_SOURCE_COLOR = '#EE0000', BALANCER_DEST_COLOR = '#00AA00';

var DEFAULT_CHUNK_COLOR = '#AEC6CF';

var statuscolors = {};

statuscolors[STATUS_MULTI_SPLIT_SOURCE] = '#D19036',
statuscolors[STATUS_MULTI_SPLIT_DEST] = '#FFD700',
statuscolors[STATUS_SPLIT_SOURCE] = '#FFA500',
statuscolors[STATUS_SPLIT_DEST] = '#FFD700',
statuscolors[STATUS_START_SOURCE] = '#00CED1',
statuscolors[STATUS_TO_SOURCE] = '#90EE90',
statuscolors[STATUS_COMMIT] = '#0000AA',
statuscolors[STATUS_FROM_SUCCESS] = '#009900',
statuscolors[STATUS_FROM_FAILURE] = '#EE0000',
statuscolors.undefined = DEFAULT_CHUNK_COLOR;

/*
statuscolors[STATUS_START_DEST] = '#AAAAAA',
statuscolors[STATUS_TO_DEST] = '#AAAAAA',
*/

// used to convert 2.x moveChunk step format to 3.x
var migratekeymap = {};

for(var i = 1; i <= 6; i++)
{
	migratekeymap["step" + i + " of 6"] = "step " + i + " of 6";
	migratekeymap["step" + i + " of 5"] = "step " + i + " of 5";
}

var s = JSON.stringify;

function remap(obj, keymap)
{
	var newObj = {};

	for(k in obj)
		newObj[(k in keymap ? keymap[k] : k)] = obj[k];

	return newObj;
}

function peekBack(array)
{
	return array[array.length-1];
}

function remove(array, object)
{
	var pos = array.indexOf(object);

	if(pos >= 0)
		array.splice(pos, 1);
}

function clone(orig) // varargs fields NOT to clone
{
	var clone = jQuery.extend(true, {}, orig);

	for(var i = 1; i < arguments.length; i++)
		delete clone[arguments[i]];

	return clone;
}

function putAll(to, from)
{
	for(var prop in from)
	{
	    if(from.hasOwnProperty(prop))
	        to[prop] = from[prop];
	}
}

function sortObject(obj)
{
	var sorted = Object.keys(obj).sort();

	var newObj = {};

	for(var k in sorted)
		newObj[sorted[k]] = obj[sorted[k]];

	return newObj;
}

function success(change)
{
	// absence of "note" field is interpreted as success (as in 2.6)
	return (change.details.note === undefined || change.details.note === "success");
}

var Shardalyzer =
{
	shards : {},
	tags : {},
	chunks : {},
	changes : [],
	watched : {},
	balancer : {},
	position : null,

	statuscolors : statuscolors,

	// arguments are objects in original format from the config database
	initialize : function(sharddata, tagdata, chunkdata, changedata)
	{
		this.changes = changedata;

		this.shards = {};
		this.chunks = {};

		this.watched = {};
		this.tags = {};

		this.migrations = [];

		var currentmove = {};

		for(var k in sharddata)
		{
			this.shards[sharddata[k]._id] = [];

			var shardtags = this.tags[sharddata[k]._id] = { tags : {} };

			for(var st in sharddata[k].tags)
			{
				var tag = sharddata[k].tags[st];

				shardtags.tags[tag] = {};

				for(var t in tagdata)
				{
					if(tagdata[t].tag == tag)
					{
						shardtags.tags[tag].min = tagdata[t].min;
						shardtags.tags[tag].max = tagdata[t].max;
					}
				}
			}
		}

		for(var k in chunkdata)
		{
			var chunk = chunkdata[k];

			this.shards[chunk.shard].push(chunk);
			this.chunks[s(chunk.min)] = chunk;
		}

		/*
		 * Iterate from end to start, i.e. in chronological order
		 * Homogenise 2.x changelog format to newer 3.0 format
		 *   - populate "from" & "to" fields in 2.x moveChunk.from
		 *   - change "stepX" in 2.x moveChunk to 3.x "step X"
		 */
		for(var i = this.changes.length-1; i >= 0; i--)
		{
			if(this.changes[i].what == OP_START || this.changes[i].what == OP_COMMIT)
				currentmove[this.changes[i].what] = this.changes[i];
			else if(this.changes[i].what == OP_TO)
			{
				// change 2.x "stepX" to 3.x "step X"
				if(this.changes[i].details["step1 of 5"])
					this.changes[i].details = remap(this.changes[i].details, migratekeymap);

				currentmove[OP_TO] = this.changes[i];
			}
			else if(this.changes[i].what == OP_FROM)
			{
				// change 2.x "stepX" to 3.x "step X"
				if(this.changes[i].details["step1 of 6"])
					this.changes[i].details = remap(this.changes[i].details, migratekeymap);

				if(this.changes[i].details.from == undefined)
				{
					var context = (currentmove[OP_START] || currentmove[OP_COMMIT]);

					if(context && context.details.from !== undefined)
					{
						this.changes[i].details.from = context.details.from;
						this.changes[i].details.to = context.details.to;
					}
					else if(success(this.changes[i])) // change is not reproducible
					{
						this.changes.splice(i, 1);
						currentmove = {};
						continue;
					}
				}

				if(success(this.changes[i]))
				{
					currentmove[OP_FROM] = this.changes[i];
					this.migrations[i] = currentmove;
				}

				currentmove = {};
			}
		}

		// if chunkdata is empty, position is null else 0
		// clusters with no changelog entries still valid
		this.position = (chunkdata.length > 0 ? 0 : null);

		if(this.canRewind())
			this.tag(this.chunks, this.changes[0]);

		this.updateBalancer();
	},

	reset : function()
	{
		this.initialize([], [], [], []);
	},

	// ns-minkey0_val-minkeyN_val
	generateChunkId : function(ns, minShardKey)
	{
		// generate the ID of the new chunk
		var newId = ns;

		// iterates in correct shardkey order
		for(var k in minShardKey)
			newId = newId.concat("-").concat(k).concat("_").concat(s(minShardKey[k]));

		newId = newId.replace(/"/g, "");

		return newId;
	},

	updateBalancer : function()
	{
		var max = -1, min = Number.MAX_VALUE;

		var current = 0;
		var total = 0;

		this.balancer = {};

		for(var shard in this.shards)
		{
			total += (current = this.shards[shard].length);

			max = Math.max(current, max);
			min = Math.min(current, min);
		}

		var diff = max - min;

		/* http://docs.mongodb.org/manual/core/sharding-balancing/#migration-thresholds */
		if(diff >= 8 || (diff >= 4 && total < 80) || (diff >= 2 && total < 20))
		{
			for(var shard in this.shards)
			{
				if(this.shards[shard].length == max)
					this.balancer[shard] = BALANCER_SOURCE_COLOR;
				else if(this.shards[shard].length == min)
					this.balancer[shard] = BALANCER_DEST_COLOR;
			}
		}
	},

	watchChunk : function(shardkey)
	{
		var skey = (typeof shardkey === 'string' ? shardkey : s(shardkey));

		this.watched[skey] = (this.watched[skey] ||
			('#'+Math.floor(Math.random()*16777215).toString(16)));
	},

	unwatchChunk : function(shardkey)
	{
		var skey = (typeof shardkey === 'string' ? shardkey : s(shardkey));
		if(this.chunks[skey]) delete this.chunks[skey].watched;
		delete(this.watched[skey]);
	},

	updateWatchlist : function()
	{
		for(var skey in this.watched)
		{
			if(this.chunks[skey])
				this.chunks[skey].watched = this.watched[skey];
		}
	},

/*
{
	"_id" : "<hostname>-<timestamp>-<increment>",
	"server" : "<hostname><:port>",
	"clientAddr" : "127.0.0.1:63381",
	"time" : ISODate("2012-12-11T14:09:21.039Z"),
	"what" : "split",
	"ns" : "<database>.<collection>",
	"details" : {
		"before" : {
			"min" : {
				"<database>" : { $minKey : 1 }
			},
			"max" : {
				"<database>" : { $maxKey : 1 }
			},
			"lastmod" : Timestamp(1000, 0),
			"lastmodEpoch" : ObjectId("000000000000000000000000")
			},
    	"left" : {
			"min" : {
				"<database>" : { $minKey : 1 }
			},
			"max" : {
				"<database>" : "<value>"
			},
			"lastmod" : Timestamp(1000, 1),
			"lastmodEpoch" : ObjectId(<...>)
		},
		"right" : {
			min" : {
				"<database>" : "<value>"
			},
			"max" : {
				"<database>" : { $maxKey : 1 }
			},
			"lastmod" : Timestamp(1000, 2),
			"lastmodEpoch" : ObjectId("<...>")
		}
	}
}
 */
	applySplit : function(chunks, shards, change)
	{
		var left = change.details.left;
		var right = change.details.right;
		var before = change.details.before;

		// the original chunk
		var chunk = chunks[s(before.min)];

		// update the source chunk' details
		putAll(chunk, left);

		// create new chunk based on old
		var newChunk = clone(chunk, "watched");

		// update the new chunk's details
		putAll(newChunk, right);

		// generate an _id for the new chunk
		newChunk._id = this.generateChunkId(newChunk.ns, newChunk.min);

		// add new chunk to topology
		shards[newChunk.shard].push(newChunk);
		chunks[s(newChunk.min)] = newChunk;
	},

	revertSplit : function(chunks, shards, change)
	{
		var left = change.details.left;
		var right = change.details.right;
		var before = change.details.before;

		var chunk = chunks[s(left.min)];
		var splitChunk = chunks[s(right.min)];

		// remove right chunk...
		remove(shards[splitChunk.shard], splitChunk);
		delete chunks[s(right.min)];

		// ... and revert left
		putAll(chunk, before);
	},

/*
{
	"_id" : "Bernards-MacBook-Pro.local-2015-07-13T12:04:08-55a3a9381e8e9aa0007de5bb",
	"server" : "Bernards-MacBook-Pro.local",
	"clientAddr" : "10.7.31.173:51616",
	"time" : ISODate("2015-07-13T12:04:08.778Z"),
	"what" : "multi-split",
	"ns" : "bootcamp.twitter",
	"details" : {
		"before" : {
			"min" : {
				"user.id" : 371516615
			},
			"max" : {
				"user.id" : 610496671
			}
		},
		"number" : 1,
		"of" : 5,
		"chunk" : {
			"min" : {
				"user.id" : 371516615
			},
			"max" : {
				"user.id" : 418954948
			},
			"lastmod" : Timestamp(3, 10),
			"lastmodEpoch" : ObjectId("55a3a8fc2116282c008491df")
		}
	}
}
 ...
{
	"_id" : "Bernards-MacBook-Pro.local-2015-07-13T12:04:08-55a3a9381e8e9aa0007de5bf",
	"server" : "Bernards-MacBook-Pro.local",
	"clientAddr" : "10.7.31.173:51616",
	"time" : ISODate("2015-07-13T12:04:08.799Z"),
	"what" : "multi-split",
	"ns" : "bootcamp.twitter",
	"details" : {
		"before" : {
			"min" : {
				"user.id" : 371516615
			},
			"max" : {
				"user.id" : 610496671
			}
		},
		"number" : 5,
		"of" : 5,
		"chunk" : {
			"min" : {
				"user.id" : 592098546
			},
			"max" : {
				"user.id" : 610496671
			},
			"lastmod" : Timestamp(3, 14),
			"lastmodEpoch" : ObjectId("55a3a8fc2116282c008491df")
		}
	}
}
 */
	applyMultiSplit : function(chunks, shards, change)
	{
		// the original chunk's metadata
		var before = change.details.before;

		// the original chunk
		var chunk = chunks[s(before.min)];

		// this split's position in the sequence
		var splitNum = change.details.number;

		// get the metadata of the new chunk
		var newMeta = change.details.chunk;
		var newMin = newMeta.min;

		if(splitNum == 1)
			putAll(chunk, newMeta); // split 1 of N updates existing chunk
		else
		{
			// subsequent splits create new chunks
			var newChunk = clone(chunk, "watched");
			putAll(newChunk, newMeta);

			// generate an ID for the new chunk
			newChunk._id = this.generateChunkId(chunk.ns, newMin);

			// add new chunk to topology
			shards[newChunk.shard].push(newChunk);
			chunks[s(newChunk.min)] = newChunk;
		}
	},

	revertMultiSplit : function(chunks, shards, change)
	{
		// the original chunk's metadata
		var before = change.details.before;

		// the original chunk
		var chunk = chunks[s(before.min)];

		// this split's position in the sequence
		var splitNum = change.details.number;

		// get the metadata of the new chunk
		var newMeta = change.details.chunk;
		var newMin = newMeta.min;

		// get the child chunk
		var newChunk = chunks[s(newMin)];

		if(splitNum == 1)
		{
			// 2.6 {before} includes original lastmod & Epoch
			// 3.0 omits this information, need to recreate
			chunk.lastmod = newMeta.lastmod;
			//chunk.lastmodUnsplit();

			// revert parent chunk
			putAll(chunk, before);
		}
		else
		{
			// remove the child chunk
			remove(shards[newChunk.shard], newChunk);
			delete chunks[s(newMin)];
		}
	},

/*
{
	"_id" : "Bernards-MacBook-Pro.local-2015-07-13T12:17:12-55a3ac481e8e9aa0007de63d",
	"server" : "Bernards-MacBook-Pro.local",
	"clientAddr" : "10.7.31.173:51616",
	"time" : ISODate("2015-07-13T12:17:12.348Z"),
	"what" : "moveChunk.from",
	"ns" : "bootcamp.twitter",
	"details" : {
		"min" : {
			"user.id" : 939361788
		},
		"max" : {
			"user.id" : 958661575
		},
		"step 1 of 6" : 0,
		"step 2 of 6" : 431,
		"step 3 of 6" : 81,
		"step 4 of 6" : 30010,
		"step 5 of 6" : 238,
		"step 6 of 6" : 0,
		"to" : "shard03",
		"from" : "shard01",
		"note" : "success"
	}
}
*/
	applyMoveFrom : function(chunks, shards, change)
	{
		var from = change.details.from;
		var to = change.details.to;

		var chunk = chunks[s(change.details.min)];

		if(success(change))
		{
			remove(shards[from], chunk);
			shards[to].push(chunk);
			chunk.shard = to;
			//chunk.lastmodUnmove(0);
		}
	},

	revertMoveFrom : function(chunks, shards, change)
	{
		var from = change.details.from;
		var to = change.details.to

		var chunk = chunks[s(change.details.min)];

		if(success(change))
		{
			remove(shards[to], chunk);
			shards[from].unshift(chunk);
			chunk.shard = from;
			//chunk.lastmodMove(0);
		}
	},

/*
{
	"_id" : "Bernards-MacBook-Pro.local-2015-07-13T12:17:58-55a3ac76dabc7320d7ef6273",
	"server" : "Bernards-MacBook-Pro.local",
	"clientAddr" : "10.7.31.173:51618",
	"time" : ISODate("2015-07-13T12:17:58.092Z"),
	"what" : "moveChunk.start",
	"ns" : "bootcamp.twitter",
	"details" : {
		"min" : {
			"user.id" : 1612021
		},
		"max" : {
			"user.id" : 23516767
		},
		"from" : "shard03",
		"to" : "shard02"
	}
}
*/
	applyMoveStart : function(chunks, shards, change)
	{
/*		var from = change.details.from;
		var to = change.details.to;

		// get relevant chunk
		var chunk = chunks[s(change.details.min)];
		chunk.shard = to;
		//chunk.lastmodMove(0);

		// TODO: dupe chunk, put it in dest shard, tag as START_DEST for vis

		// move the chunk from one shard to the other
		remove(shards[from], chunk);
		shards[to].push(chunk);
*/
	},

	revertMoveStart : function(chunks, shards, change)
	{
/*
		var from = change.details.from;
		var to = change.details.to;

		// get relevant chunk
		var chunk = chunks[s(change.details.min)];
		chunk.shard = from;
		//chunk.lastmodUnmove(0);

		// restore the chunk to the original shard
		remove(shards[to], chunk);
		shards[from].push(chunk);
*/
	},

	applyMoveTo : function(chunks, shards, change)
	{
		// nothing to do here at present
	},

	revertMoveTo : function(chunks, shards, change)
	{
		// nothing to do here at present
	},

	applyMoveCommit : function(chunks, shards, change)
	{
		// nothing to do here at present
	},

	revertMoveCommit : function(chunks, shards, change)
	{
		// nothing to do here at present
	},

	tag : function(chunks, change)
	{
		switch(change.what)
		{
			case OP_START:
				chunks[s(change.details.min)].status = STATUS_START_SOURCE;
				break;

			case OP_FROM:
				chunks[s(change.details.min)].status =
					(success(change) ? STATUS_FROM_SUCCESS : STATUS_FROM_FAILURE);

				break;

			case OP_TO:
				chunks[s(change.details.min)].status = STATUS_TO_SOURCE;
				break;

			case OP_COMMIT:
				chunks[s(change.details.min)].status = STATUS_COMMIT;
				break;

			case OP_MULTI_SPLIT:

				var before = change.details.before;
				var newMeta = change.details.chunk;

				chunks[s(before.min)].status = STATUS_MULTI_SPLIT_SOURCE;

				// don't tag if splitNum == 1; both chunk refs same
				if(change.details.number > 1)
					chunks[s(newMeta.min)].status = STATUS_MULTI_SPLIT_DEST;

				break;

			case OP_SPLIT:

				var left = change.details.left;
				var right = change.details.right;

				chunks[s(left.min)].status = STATUS_SPLIT_SOURCE;
				chunks[s(right.min)].status = STATUS_SPLIT_DEST;

				break;
		}
	},

	untag : function(chunks, change)
	{
		switch(change.what)
		{
			case OP_START:
				delete chunks[s(change.details.min)].status;
				break;

			case OP_FROM:
				delete chunks[s(change.details.min)].status;
				break;

			case OP_TO:
				delete chunks[s(change.details.min)].status;
				break;

			case OP_COMMIT:
				delete chunks[s(change.details.min)].status;
				break;

			case OP_MULTI_SPLIT:

				var before = change.details.before;
				var newMeta = change.details.chunk;

				delete chunks[s(before.min)].status;
				delete chunks[s(newMeta.min)].status;

				break;

			case OP_SPLIT:

				var left = change.details.left;
				var right = change.details.right;

				delete chunks[s(left.min)].status;
				delete chunks[s(right.min)].status;

				break;
		}
	},

	canFastForward : function()
	{
		return this.changes.length > 0 && this.position > 0;
	},

	canRewind : function()
	{
		return this.changes.length > 0 && this.position < this.changes.length;
	},

	rewind : function()
	{
		if(this.canRewind())
		{
			this.untag(this.chunks, this.changes[this.position]);

			switch(this.changes[this.position].what)
			{
				case OP_START:
					this.revertMoveStart(this.chunks, this.shards, this.changes[this.position]);
					break;

				case OP_FROM:
					this.revertMoveFrom(this.chunks, this.shards, this.changes[this.position]);
					break;

				case OP_TO:
					this.revertMoveTo(this.chunks, this.shards, this.changes[this.position]);
					break;

				case OP_COMMIT:
					this.revertMoveCommit(this.chunks, this.shards, this.changes[this.position]);
					break;

				case OP_MULTI_SPLIT:
					this.revertMultiSplit(this.chunks, this.shards, this.changes[this.position]);
					break;

				case OP_SPLIT:
					this.revertSplit(this.chunks, this.shards, this.changes[this.position]);
					break;
			}

			this.position++;

			if(this.position < this.changes.length)
				this.tag(this.chunks, this.changes[this.position]);

			this.updateWatchlist();
			this.updateBalancer();
		}
	},

	fastforward : function()
	{
		if(this.canFastForward())
		{
			if(this.position < this.changes.length)
				this.untag(this.chunks, this.changes[this.position]);

			switch(this.changes[--this.position].what)
			{
				case OP_START:
					this.applyMoveStart(this.chunks, this.shards, this.changes[this.position]);
					break;

				case OP_FROM:
					this.applyMoveFrom(this.chunks, this.shards, this.changes[this.position]);
					break;

				case OP_TO:
					this.applyMoveTo(this.chunks, this.shards, this.changes[this.position]);
					break;

				case OP_COMMIT:
					this.applyMoveCommit(this.chunks, this.shards, this.changes[this.position]);
					break;

				case OP_MULTI_SPLIT:
					this.applyMultiSplit(this.chunks, this.shards, this.changes[this.position]);
					break;

				case OP_SPLIT:
					this.applySplit(this.chunks, this.shards, this.changes[this.position]);
					break;
			}

			this.tag(this.chunks, this.changes[this.position]);
			this.updateWatchlist();
			this.updateBalancer();
		}
	},

	// { shard : bool }, { chunk : bool }, [0, 1, 3, 15, ..., n ]
	bttf : function(instant, shardfilter, chunkfilter, changefilter)
	{
		if(this.position == null || instant < 0 || instant > this.changes.length || instant == this.position)
			return;

		var dir = (this.position - instant > 0 ? 1 : -1);

		while(instant !== this.position)
			this.step(dir);

		while(!this.eof() && !this.filter(shardfilter, chunkfilter, changefilter))
			this.step(dir);
	},

	step : function(dir)
	{
		if(dir < 0)
			this.rewind();
		else if(dir > 0)
			this.fastforward();
	},

	filter : function(shardfilter, chunkfilter, changefilter)
	{
		if(changefilter)
		{
			for(var i = 0; i < changefilter.length && changefilter[i] < this.position; i++);

			if(changefilter[i] != this.position)
				return false;
		}

		var change = this.changes[this.position];

		if(!change || !(shardfilter || chunkfilter))
			return true;

		switch(change.what)
		{
			case OP_MULTI_SPLIT:
			case OP_SPLIT:
				var skey = s(change.details.before.min);
				break;

			case OP_FROM:
			case OP_START:
			case OP_COMMIT:
			case OP_TO:
				var skey = s(change.details.min);
				break;

			default:
				return true;
		}

		var chunk = this.chunks[skey];

		return ((!chunkfilter || chunkfilter[skey]) &&
			(shardfilter[chunk.shard] || (change.what === OP_FROM && shardfilter[change.details.from])));
	},

	eof : function()
	{
		return (this.position == 0 || this.position == this.changes.length);
	}
};
