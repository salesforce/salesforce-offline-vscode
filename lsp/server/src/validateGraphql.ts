/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */

import {parse, ASTNode} from 'graphql';
import { gqlPluckFromCodeStringSync } from '@graphql-tools/graphql-tag-pluck';
import { Diagnostic } from 'vscode-languageserver/node';
import { DiagnosticProducer } from './diagnostic/DiagnosticProducer';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { MisspelledUiapi } from './diagnostic/gql/misspelled-uiapi';

const diagnosticProducers: DiagnosticProducer<ASTNode>[] = [];
diagnosticProducers.push(new MisspelledUiapi());

/**
 * Validate the graphql queries in the document.
 * @param textDocument 
 * @param maxCount  The max count of diagnostics to return 
 */
export async function validateGraphql(
    textDocument: TextDocument, 
    maxCount: number
): Promise<Diagnostic[]> {
    const results: Diagnostic[] = [];

    if (maxCount <= 0 || diagnosticProducers.length === 0) {
        return results;
    }

    // Find the gql``s in the file content
    const graphQueries = gqlPluckFromCodeStringSync(
        textDocument.uri,
        textDocument.getText(),
        {
            skipIndent: true,
            globalGqlIdentifierName: ['gql', 'graphql']
        }
    );

    // Validate each query
    for (const query of graphQueries) {
        if (results.length >= maxCount) {
            break;
        }
        const lineOffset = query.locationOffset.line - 1;
        const columnOffset = query.locationOffset.column + 1;
        const graphqlTextDocument = TextDocument.create(``, 'graphql', 1, query.body);
        const diagnostics = await validateOneGraphQuery(graphqlTextDocument, query.body);
        // Update the range offset correctly
        for (const item of diagnostics) {
            if (results.length >= maxCount) {
                break;
            }
            updateDiagnosticOffset(item, lineOffset, columnOffset);
            results.push(item);
        }
    }

    return results;
}

/**
 * Validate graphql diagnostic rules to a graph query, return empty list if the graphql string is invalid.
 * @param graphql the graph code
 * @param graphqlDiagnosticProducers  the collection of graphql rules. 

 */
export async function validateOneGraphQuery(textDocument: TextDocument, graphql: string): Promise<Diagnostic[]> {
  
    try {
        const graphqlAstNode = parse(graphql);
        const allResults = await Promise.all(
            diagnosticProducers.map((producer) =>
                producer.validateDocument(textDocument, graphqlAstNode)
            )
        );
        return allResults.flat();
    } catch (e) {
        // Graphql string fails to parse will not produce diagnostic
    }

    return [];
}

/**
 * Update the graphql diagnostic offset to offset from the whole js file
 * @param diagnostic 
 * @param lineOffset Line offset from the file
 * @param columnOffset Column offset from the file
 */
function updateDiagnosticOffset(diagnostic: Diagnostic, lineOffset: number, columnOffset: number) {

    const start = diagnostic.range.start;
    const end = diagnostic.range.end;

    // Only add the column offset for first line.
    if (start.line === 0) {
        start.character += columnOffset;
    }
    if (end.line === 0) {
        end.character += columnOffset;
    }

    start.line += lineOffset;
    end.line += lineOffset;
}