function require(name) {
	return emmet.require(name);
}

var _completions = {};

var _ = require('lodash');
var editorUtils = require('utils/editor');
var actionUtils = require('utils/action');
var range = require('assets/range');
var tabStops = require('assets/tabStops');
var utils = require('utils/common');
var htmlMatcher = require('assets/htmlMatcher');
var resources = require('assets/resources');
var cssResolver = require('resolver/css');
var abbreviationParser = require('parser/abbreviation');
var expandAbbreviationAction = require('action/expandAbbreviation');

function activeView() {
	return sublime.active_window().active_view();
}

var editorProxy = {
	getSelectionRange: function() {
		var view = activeView();
		var sel = view.sel()[0];
		return {
			start: sel.begin(),
			end: sel.end()
		};
	},

	createSelection: function(start, end) {
		var view = activeView();
		view.sel().clear();

		view.sel().add(new sublime.Region(start, end || start));
		view.show(view.sel());
	},

	getCurrentLineRange: function() {
		var view = activeView();
		var selection = view.sel()[0];
		var line = view.line(selection);
		return {
			start: line.begin(),
			end: line.end()
		};
	},

	getCaretPos: function() {
		var view = activeView();
		var sel = view.sel();
		return sel && sel[0] ? sel[0].begin() : 0;
	},

	setCaretPos: function(pos){
		this.createSelection(pos, pos);
	},

	getCurrentLine: function() {
		var view = activeView();
		return view.substr(view.line(view.sel()[0]));
	},

	replaceContent: function(value, start, end, noIndent) {
		if (_.isUndefined(end))
			end = _.isUndefined(start) ? this.getContent().length : start;
		if (_.isUndefined(start)) start = 0;

		// update tabstops: make sure all caret placeholder are unique
		// by default, abbreviation parser generates all unlinked (un-mirrored)
		// tabstops as ${0}, so we have upgrade all caret tabstops with unique
		// positions but make sure that all other tabstops are not linked accidentally
		value = pyPreprocessText(value);
		value = editorUtils.normalize(value);
		sublimeReplaceSubstring(start, end, value, !!noIndent);
	},

	getContent: function() {
		var view = activeView();
		return view.substr(new sublime.Region(0, view.size()));
	},

	getSyntax: function() {
		return pyGetSyntax();
	},

	getProfileName: function() {
		var view = activeView();
		var pos = this.getCaretPos();

		if (view.match_selector(pos, 'text.html') 
			&& sublimeGetOption('autodetect_xhtml', false)
			&& actionUtils.isXHTML(this)) {
			return 'xhtml';
		}

		if (view.match_selector(pos, 'string.quoted.double.block.python')
			|| view.match_selector(pos, 'source.coffee string')
			|| view.match_selector(pos, 'string.unquoted.heredoc')) {
			// use html's default profile for:
			// * Python's multiline block
			// * CoffeeScript string
			// * PHP heredoc
			return pyDetectProfile();
		}

		if (view.score_selector(pos, 'source string')) {
			return 'line';
		}

		return pyDetectProfile();
	},

	prompt: function(title) {
		return pyEditor.prompt();
	},

	getSelection: function() {
		var view = activeView();
		return view.sel() ? view.substr(view.sel()[0]) : '';
	},

	getFilePath: function() {
		return activeView().file_name();
	}
};

function pyPreprocessText(value) {
	var base = 1000;
	var zeroBase = 0;
	var lastZero = null;

	var tabstopOptions = {
		tabstop: function(data) {
			var group = parseInt(data.group, 10);
			var isZero = group === 0;
			if (isZero)
				group = ++zeroBase;
			else
				group += base;

			var placeholder = data.placeholder;
			if (placeholder) {
				// recursively update nested tabstops
				placeholder = tabStops.processText(placeholder, tabstopOptions);
			}

			var result = '${' + group + (placeholder ? ':' + placeholder : '') + '}';

			if (isZero) {
				lastZero = range.create(data.start, result);
			}

			return result
		},
		escape: function(ch) {
			if (ch == '$') {
				return '\\$';
			}

			if (ch == '\\') {
				return '\\\\';
			}
 
			return ch;
		}
	};

	value = tabStops.processText(value, tabstopOptions);

	if (sublimeGetOption('insert_final_tabstop', false) && !/\$\{0\}$/.test(value)) {
		value += '${0}';
	} else if (lastZero) {
		value = utils.replaceSubstring(value, '${0}', lastZero);
	}
	
	return value;
}

function pyExpandAbbreviationAsYouType(abbr) {
	var info = editorUtils.outputInfo(editorProxy);
	try {
		var result = emmet.expandAbbreviation(abbr, info.syntax, info.profile, 
					actionUtils.captureContext(editorProxy));
		return pyPreprocessText(result);
	} catch (e) {
		return '';
	}
	
}

function pyWrapAsYouType(abbr, content) {
	var info = editorUtils.outputInfo(editorProxy);
	content = utils.escapeText(content);
	var ctx = actionUtils.captureContext(editorProxy);
	try {
		var result = abbreviationParser.expand(abbr, {
			pastedContent: content,
			syntax: info.syntax, 
			profile: info.profile,
			contextNode: actionUtils.captureContext(editorProxy)
		});
		return pyPreprocessText(result);
	} catch(e) {
		return '';
	}
}

function pyCaptureWrappingRange() {
	var info = editorUtils.outputInfo(editorProxy);
	var range = editorProxy.getSelectionRange();
	var startOffset = range.start;
	var endOffset = range.end;
	
	if (startOffset == endOffset) {
		// no selection, find tag pair
		var match = htmlMatcher.find(info.content, startOffset);
		if (!match) {
			// nothing to wrap
			return null;
		}
		
		var narrowedSel = utils.narrowToNonSpace(info.content, match.range);
		startOffset = narrowedSel.start;
		endOffset = narrowedSel.end;
	}

	return [startOffset, endOffset];
}

function pyGetTagNameRanges(pos) {
	var ranges = [];
	var info = editorUtils.outputInfo(editorProxy);
		
	// search for tag
	try {
		var tag = htmlMatcher.tag(info.content, pos);
		if (tag) {
			var open = tag.open.range;
			var tagName = /^<([\w\-\:]+)/i.exec(open.substring(info.content))[1];
			ranges.push([open.start + 1, open.start + 1 + tagName.length]);

			if (tag.close) {
				ranges.push([tag.close.range.start + 2, tag.close.range.start + 2 + tagName.length]);
			}
		}
	} catch (e) {}

	return ranges;
}

function pyGetTagRanges() {
	var ranges = [];
	var info = editorUtils.outputInfo(editorProxy);
		
	// search for tag
	try {
		var tag = htmlMatcher.tag(info.content, editorProxy.getCaretPos());
		if (tag) {
			ranges.push(tag.open.range.toArray());
			if (tag.close) {
				ranges.push(tag.close.range.toArray());
			}
		}
	} catch (e) {}

	return ranges;
}

function pyExtractAbbreviation() {
	return expandAbbreviationAction.findAbbreviation(editorProxy);
}

function pyHasSnippet(name) {
	return !!resources.findSnippet(editorProxy.getSyntax(), name);
}

/**
 * Get all available CSS completions. This method is optimized for CSS
 * only since it should contain snippets only so it's not required
 * to do extra parsing
 */
function pyGetCSSCompletions(dialect) {
	dialect = dialect || pyGetSyntax();

	if (!_completions[dialect]) {
		var all = resources.getAllSnippets(dialect);
		_completions[dialect] = _.map(all, function(v, k) {
			var snippetValue = typeof v.parsedValue == 'object' 
				? v.parsedValue.data
				: v.value;
			var snippet = cssResolver.transformSnippet(snippetValue, false, dialect);
			return {
				k: v.nk,
				label: snippet.replace(/\:\s*\$\{0\}\s*;?$/, ''),
				v: cssResolver.expandToSnippet(v.nk, dialect)
			};
		});
	}

	return _completions[dialect];
}

/**
 * Returns current syntax name
 * @return {String}
 */
function pyGetSyntax() {
	var view = activeView();
	var pt = view.sel()[0].begin();
	var scope = 'scope_name' in view ? view.scope_name(pt) : view.syntax_name(pt);

	if (~scope.indexOf('xsl')) {
		return 'xsl';
	}

	var syntax = 'html';

	if (!/\bstring\b/.test(scope) && /\bsource\.([\w\-]+)/.test(scope) && resources.hasSyntax(RegExp.$1)) {
		syntax = RegExp.$1;
	} else if (/\b(less|scss|sass|css|stylus)\b/.test(scope)) {
		// detect CSS-like syntaxes independently, 
		// since it may cause collisions with some highlighters
		syntax = RegExp.$1;
	} else if (/\b(html|xml|haml|slim)\b/.test(scope)) {
		syntax = RegExp.$1;
	}

	return actionUtils.detectSyntax(editorProxy, syntax);
}

function pyDetectProfile(syntax) {
	return actionUtils.detectProfile(editorProxy, syntax);
}