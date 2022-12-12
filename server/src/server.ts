/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	TextDocumentSyncKind,
	InitializeResult,
} from 'vscode-languageserver/node';

import * as path from 'path';
import * as url from 'url';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

// import Scanner from 'flawed-code-scanner/lib/runner';
// import type { ScanPluginsConf } from 'flawed-code-scanner/lib/plugins';
// import ErrorCollector from 'flawed-code-scanner/lib/runner/errorCollector';

import { 
	Scanner, 
	ScanPluginsConf, 
	ErrorCollector,
	ErrorLevel
} from 'flawed-code-scanner';

import ScannerServer, { defaultScannerConfig } from './scannerServer';

/**
 * 使用 Node IPC 进行数据传输，为服务器创建链接
 */
const connection = createConnection(ProposedFeatures.all);

/**
 * 一个简单的 document 管理器
 */
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

/**
 * scanner 实例
 */
const scanner = new Scanner();

/**
 * 初始化一个错误收集器的管理器
 */
const collectorMap = new Map<string, ErrorCollector>();


/**
 * 根据 uri 返回一个 collector
 */
function getCollectorByUrl (uri: string) {
	if(collectorMap.has(uri)) {
		return collectorMap.get(uri) as ErrorCollector;
	} else {
		const collector = new ErrorCollector();
		collectorMap.set(uri, collector);
		return collector;
	}
}


let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// completionProvider: {
			// 	resolveProvider: true
			// }
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface ISettings {
	maxNumberOfProblems: number;
	scanPluginsConf: ScanPluginsConf[];
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ISettings = {
	maxNumberOfProblems: 1000,
	scanPluginsConf: defaultScannerConfig.scanPlugins
};
let globalSettings: ISettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ISettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	connection.console.log(JSON.stringify(change));
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ISettings>(
			(change.settings.languageServerExample || defaultSettings)
		);
	}

	// 清除所有的 codeError
	collectorMap.forEach((c) => {
		c.clearAll();
	});

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);

});


function getDocumentSettings(resource: string): Thenable<ISettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'languageServerExample'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

const allLanguageIds = [
	"javascript",
	"typescript",
	"javascriptreact",
	"typescriptreact"
];

function getPluginByLanguageId (languageId: string) {
	switch(languageId){
		case "javascript":
			return [];
		case "typescript":
			return ['typescript'];
		case "javascriptreact":
			return ['jsx'];
		case "typescriptreact":
			return ['jsx', 'typescript'];
		default:
			return [];
	}
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	if(!allLanguageIds.includes(textDocument.languageId)) {
		return;
	}
	// In this simple example we get the settings for every validate run.
	const settings = await getDocumentSettings(textDocument.uri);
	const collector = getCollectorByUrl(textDocument.uri);
	collector.clearAll();
	const scannerPlugins = Scanner.genScanPluginsConf(settings.scanPluginsConf ?? defaultScannerConfig.scanPlugins, collector);
	connection.console.log(textDocument.uri);
	connection.console.log(JSON.stringify(path.parse(url.parse(textDocument.uri).pathname ?? '')));
	connection.console.log(''+textDocument.version);


	scanner.setConfig({
		scanPluginsConf: scannerPlugins,
		code: textDocument.getText(),
		filePath: textDocument.uri,
		babelParsePlugins: getPluginByLanguageId(textDocument.languageId) as any[]
	});

	try{
		scanner.run();
	} catch (e) {
		connection.console.error('code parse error!');
	}

	const errors = collector.getCodeErrors();
	const diagnostics: Diagnostic[] = [];

	errors.forEach((type, error) => {
		const diagnostic: Diagnostic = {
			severity: error.errorLevel,
			range: {
				start: textDocument.positionAt(error.range[0]),
				end: textDocument.positionAt(error.range[1])
			},
			
			message: `${ErrorLevel[error.errorLevel]}: ${error.pluginTips}`,
			source: 'code-scanner'
		};
		if (hasDiagnosticRelatedInformationCapability && error.extraMsg) {
			diagnostic.relatedInformation = [
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range)
					},
					message: error.extraMsg
				}
			];
		}
		diagnostics.push(diagnostic);
	});

	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
	connection.sendRequest('request', {text: "send request"});
	connection.sendNotification('notification', {text: "send notification"});
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});


// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
