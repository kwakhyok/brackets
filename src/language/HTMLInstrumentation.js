/*
 * Copyright (c) 2013 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */


/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define, $, CodeMirror */

/**
 * HTMLInstrumentation
 *
 * This module contains functions for "instrumenting" html code. Instrumented code
 * adds a "data-brackets-id" attribute to every tag in the code. The value of this
 * tag is guaranteed to be unique.
 *
 * The primary function is generateInstrumentedHTML(). This does just what it says -
 * it will read the HTML content in the doc and generate instrumented code by injecting
 * "data-brackets-id" attributes.
 *
 * There are also helper functions for returning the tagID associated with a specified
 * position in the document.
 */
define(function (require, exports, module) {
    "use strict";

    var DOMHelpers = require("LiveDevelopment/Agents/DOMHelpers"),
        MarkedTextTracker = require("utils/MarkedTextTracker");
    
    // Hash of scanned documents. Key is the full path of the doc. Value is an object
    // with two properties: timestamp and tags. Timestamp is the document timestamp,
    // tags is an array of tag info with start, length, and tagID properties.
    var _cachedValues = {};

    /**
     * @private
     * Returns true if the specified tag is empty. This could be an empty HTML tag like 
     * <meta> or <link>, or a closed tag like <div />
     */
    function _isEmptyTag(payload) {
        if (payload.closed || !payload.nodeName) {
            return true;
        }
        
        if (/(!doctype|area|base|basefont|br|wbr|col|frame|hr|img|input|isindex|link|meta|param|embed)/i
                .test(payload.nodeName)) {
            return true;
        }
        
        return false;
    }
    
    /**
     * Scan a document to prepare for HTMLInstrumentation
     * @param {Document} doc The doc to scan. 
     * @return {Array} Array of tag info, or null if no tags were found
     */
    function scanDocument(doc) {
        if (_cachedValues[doc.file.fullPath]) {
            var cachedValue = _cachedValues[doc.file.fullPath];
            
            if (cachedValue.timestamp === doc.diskTimestamp) {
                return cachedValue.tags;
            }
        }
        
        var text = doc.getText(),
            tagID = 1;
        
        // Scan 
        var tags = [];
        var tagStack = [];
        var tag;
        
        DOMHelpers.eachNode(text, function (payload) {
            // Ignore closing empty tags like </input> since they're invalid.
            if (payload.closing && _isEmptyTag(payload)) {
                return;
            }
            if (payload.nodeType === 1 && payload.nodeName) {
                // Set unclosedLength for the last tag
                if (tagStack.length > 0) {
                    tag = tagStack[tagStack.length - 1];
                    
                    if (!tag.unclosedLength) {
                        if (tag.nodeName === "HTML" || tag.nodeName === "BODY") {
                            tag.unclosedLength = text.length - tag.sourceOffset;
                        } else {
                            tag.unclosedLength = payload.sourceOffset - tag.sourceOffset;
                        }
                    }
                }
                
                // Empty tag
                if (_isEmptyTag(payload)) {
                    tags.push({
                        name:   payload.nodeName,
                        data:   tagID++,
                        start:  payload.sourceOffset,
                        end:    payload.sourceOffset + payload.sourceLength
                    });
                } else if (payload.closing) {
                    // Closing tag
                    var i,
                        startTag;
                    
                    for (i = tagStack.length - 1; i >= 0; i--) {
                        if (tagStack[i].nodeName === payload.nodeName) {
                            startTag = tagStack[i];
                            tagStack.splice(i, 1);
                            break;
                        }
                    }
                    
                    if (startTag) {
                        tags.push({
                            name:   startTag.nodeName,
                            data:   tagID++,
                            start:  startTag.sourceOffset,
                            end:    payload.sourceOffset + payload.sourceLength
                        });
                    } else {
                        console.error("Unmatched end tag: " + payload.nodeName);
                    }
                } else {
                    // Opening tag
                    tagStack.push(payload);
                }
            }
        });
        
        // Remaining tags in tagStack are unclosed.
        while (tagStack.length) {
            tag = tagStack.pop();
            // Push the unclosed tag with the "unclosed" length. 
            tags.push({
                name:  tag.nodeName,
                data:  tagID++,
                start: tag.sourceOffset,
                end:   tag.sourceOffset + (tag.unclosedLength || tag.sourceLength)
            });
        }
        
        // Sort by initial offset
        tags.sort(function (a, b) {
            if (a.start < b.start) {
                return -1;
            }
            if (a.start === b.start) {
                return 0;
            }
            return 1;
        });
        
        // Cache results
        _cachedValues[doc.file.fullPath] = {
            timestamp: doc.diskTimestamp,
            tags: tags
        };
        
        return tags;
    }
    
    /**
     * Generate instrumented HTML for the specified document. Each tag has a "data-brackets-id"
     * attribute with a unique ID for its value. For example, "<div>" becomes something like
     * "<div data-brackets-id='45'>". The attribute value is just a number that is guaranteed
     * to be unique. 
     * @param {Document} doc The doc to scan. 
     * @return {string} instrumented html content
     */
    function generateInstrumentedHTML(doc) {
        var tags = scanDocument(doc).slice(),
            gen = doc.getText();
        
        // Walk through the tags and insert the 'data-brackets-id' attribute at the
        // end of the open tag
        var i, insertCount = 0;
        tags.forEach(function (tag) {
            var attrText = " data-brackets-id='" + tag.data + "'";

            // Insert the attribute as the first attribute in the tag.
            var insertIndex = tag.start + tag.name.length + 1 + insertCount;
            gen = gen.substr(0, insertIndex) + attrText + gen.substr(insertIndex);
            insertCount += attrText.length;
        });
        
        return gen;
    }
    
    /**
     * Mark the text for the specified editor. Either the scanDocument() or 
     * the generateInstrumentedHTML() function must be called before this function
     * is called.
     *
     * NOTE: This function is "private" for now (has a leading underscore), since
     * the API is likely to change in the future.
     *
     * @param {Editor} editor The editor whose text should be marked.
     * @return none
     */
    function _markText(editor) {
        var cache = _cachedValues[editor.document.file.fullPath],
            tags = cache && cache.tags;
        
        if (!tags) {
            console.error("Couldn't find the tag information for " + editor.document.file.fullPath);
            return;
        }
        
        MarkedTextTracker.markText(editor, tags, "htmlTagID");
    }
    
    /**
     * Get the instrumented tagID at the specified position. Returns -1 if
     * there are no instrumented tags at the location.
     * The _markText() function must be called before calling this function.
     *
     * NOTE: This function is "private" for now (has a leading underscore), since
     * the API is likely to change in the future.
     *
     * @param {Editor} editor The editor to scan. 
     * @return {number} tagID at the specified position, or -1 if there is no tag
     */
    function _getTagIDAtDocumentPos(editor, pos) {
        var result = MarkedTextTracker.getRangesAtDocumentPos(editor, pos, "htmlTagID");
        if (result.length) {
            return result[0].data;
        } else {
            return -1;
        }
    }
    
    exports.scanDocument = scanDocument;
    exports.generateInstrumentedHTML = generateInstrumentedHTML;
    exports._markText = _markText;
    exports._getTagIDAtDocumentPos = _getTagIDAtDocumentPos;
});