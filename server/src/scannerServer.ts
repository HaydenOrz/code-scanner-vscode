import * as path from 'path';
import * as url from 'url';

import { 
	Scanner, 
	ScanPluginsConf, 
	ErrorCollector,
	ErrorLevel
} from 'flawed-code-scanner';
import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import {
    Connection,
    Diagnostic,
} from 'vscode-languageserver/node';


// The example settings
interface ISettings {
	maxNumberOfProblems: number;
	scanPluginsConf: ScanPluginsConf[];
}

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

/**
 * code-scanner 默认配置 
 */
export const defaultScannerConfig = {
    scanPlugins: ([
        {
            plugin: "needTryCatch",
			options: {
				level: 2
			}
        },
        {
            plugin: "needHandlerInCatch"
        },
        {
            plugin: "dangerousAndOperator"
        },
        {
            plugin: "dangerousInitState"
        },
        {
            plugin: "dangerousDefaultValue"
        }
    ]) as ScanPluginsConf[]
};

class ScannerServer {
    private _connection: Connection = null;
    private _scanner: Scanner;
    private _allowRelatedInformation: boolean = true;
    
    constructor (allowRelatedInformation?: boolean) {
        this._scanner= new Scanner();
    }

    public bindConnection(connection: Connection) {
        this._connection = connection;
    }

    validate (textDocument: TextDocument, settings: ISettings) {
        if(!allLanguageIds.includes(textDocument.languageId)) {
            return;
        }
        // In this simple example we get the settings for every validate run.
        const collector = getCollectorByUrl(textDocument.uri);
        collector.clearAll();
        const scannerPlugins = Scanner.genScanPluginsConf(settings.scanPluginsConf ?? defaultScannerConfig.scanPlugins, collector);
        this._connection.console.log(textDocument.uri);
        this._connection.console.log(JSON.stringify(path.parse(url.parse(textDocument.uri).pathname ?? '')));
        this._connection.console.log(''+textDocument.version);
    
    
        this._scanner.setConfig({
            scanPluginsConf: scannerPlugins,
            code: textDocument.getText(),
            filePath: textDocument.uri,
            babelParsePlugins: getPluginByLanguageId(textDocument.languageId) as any[]
        });
    
        try{
            this._scanner.run();
        } catch (e) {
            this._connection.console.error('code parse error!');
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
            if (this._allowRelatedInformation && error.extraMsg) {
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
        this._connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
        this._connection.sendRequest('request', {text: "send request"});
        this._connection.sendNotification('notification', {text: "send notification"});
    }

}

export default ScannerServer;
