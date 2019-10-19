/*
 * Copyright 2018-2019 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {JupyterFrontEnd, JupyterFrontEndPlugin, ILayoutRestorer} from '@jupyterlab/application';
import {ICommandPalette, showDialog, Dialog, ReactWidget, WidgetTracker} from '@jupyterlab/apputils';
import {URLExt} from '@jupyterlab/coreutils';
import {DocumentRegistry, ABCWidgetFactory, DocumentWidget} from '@jupyterlab/docregistry';
import {IFileBrowserFactory} from '@jupyterlab/filebrowser';
import {ILauncher} from '@jupyterlab/launcher';
import {IMainMenu} from '@jupyterlab/mainmenu';
import {ServerConnection} from '@jupyterlab/services';

import {toArray} from '@phosphor/algorithm';
import {IDragEvent} from '@phosphor/dragdrop';
import {Widget, PanelLayout} from '@phosphor/widgets';

import {CommonCanvas, CanvasController, CommonProperties} from '@wdp/common-canvas';
import '@wdp/common-canvas/dist/common-canvas.min.css';
import 'carbon-components/css/carbon-components.min.css';
import '../style/index.css';

import * as palette from './palette.json';
import * as properties from './properties.json';
import * as i18nData from "./en.json";
import * as React from 'react';

import { IntlProvider } from "react-intl";

const PIPELINE_ICON_CLASS = 'jp-MaterialIcon ewai-PipelineIcon';
const PIPELINE_CLASS = 'ewai-PipelineEditor';
const PIPELINE_FACTORY = 'Pipeline Editor';
const PIPELINE = 'pipeline';
const PIPELINE_EDITOR_NAMESPACE = 'pipeline-editor-extension';

const commandIDs = {
  openPipelineEditor : 'pipeline-editor:open',
  openDocManager : 'docmanager:open',
  newDocManager : 'docmanager:new-untitled'
};

/**
 * Class for dialog that pops up for pipeline submission
 */
class PipelineDialog extends Widget implements Dialog.IBodyWidget<any> {

  constructor(props: any) {
    super(props);

    let layout = (this.layout = new PanelLayout());
    let htmlContent = this.getHtml(props);
    // Set default platform to kfp, since list is dynamically generated
    (htmlContent.getElementsByClassName("ewai-form-platform")[0] as HTMLSelectElement).value = "kfp";

    layout.addWidget(new Widget( {node: htmlContent} ));
  }

  getValue() {
  	return {
  	  'pipeline_name': (document.getElementById('pipeline_name') as HTMLInputElement).value,
  	  'platform': (document.getElementById('platform') as HTMLInputElement).value
  	};
  }

  getHtml(props: any) {
    let htmlContent = document.createElement('div');
    let br = '<br/>';
    let platform_options = '';
    let runtimes = props['runtimes'];

    for (let key in runtimes) {
      platform_options = platform_options + `<option value="${runtimes[key]['name']}">${runtimes[key]['display_name']}</option>`;
    }

    let content = ''
      + '<label for="pipeline_name">Pipeline Name:</label>'
      + br
      + '<input type="text" id="pipeline_name" name="pipeline_name" placeholder="Pipeline Name"/>'
      + br + br
      + '<label for="platform">Platform:</label>'
      + br
      + '<select id="platform" name="platform" class="ewai-form-platform">'
      + platform_options
      + '</select>';

    htmlContent.innerHTML = content;

    return htmlContent;
  }
 }

/**
 * Class for Common Canvas React Component
 */
class Canvas extends ReactWidget {
  app: JupyterFrontEnd;
  browserFactory: IFileBrowserFactory;
  context: DocumentRegistry.Context;

  constructor(props: any) {
    super(props);
    this.app = props.app;
    this.browserFactory = props.browserFactory;
    this.context = props.context;
  }

  render() {
    return <Pipeline
      app={this.app}
      browserFactory={this.browserFactory}
      widgetContext={this.context}
    />
  }
}

/**
 * A namespace for Pipeline.
 */
namespace Pipeline {
  /**
   * The props for Pipeline.
   */
  export interface Props {
    app: JupyterFrontEnd;
    browserFactory: IFileBrowserFactory;
    widgetContext: DocumentRegistry.Context;
  }

  /**
   * The props for Pipeline.
   */
  export interface State {
    /**
     * Whether the properties dialog is visible.
     */
    showPropertiesDialog: boolean;

    /**
     * The form contents of the properties dialog.
     */
    propertiesInfo: any;
  }
}

class Pipeline extends React.Component<Pipeline.Props, Pipeline.State> {
  app: JupyterFrontEnd;
  browserFactory: IFileBrowserFactory;
  canvasController: any;
  widgetContext: DocumentRegistry.Context;
  position: number = 10;
  node: React.RefObject<HTMLDivElement>;

  constructor(props: any) {
    super(props);
    this.app = props.app;
    this.browserFactory = props.browserFactory;
    this.canvasController = new CanvasController();
    this.canvasController.setPipelineFlowPalette(palette);
    this.widgetContext = props.widgetContext;
    this.widgetContext.ready.then( () => {
      this.canvasController.setPipelineFlow(this.widgetContext.model.toJSON());
    });
    this.toolbarMenuActionHandler = this.toolbarMenuActionHandler.bind(this);
    this.contextMenuHandler = this.contextMenuHandler.bind(this);
    this.contextMenuActionHandler = this.contextMenuActionHandler.bind(this);
    this.editActionHandler = this.editActionHandler.bind(this);

    this.state = {showPropertiesDialog: false, propertiesInfo: {}};

    this.applyPropertyChanges = this.applyPropertyChanges.bind(this);
    this.closePropertiesDialog = this.closePropertiesDialog.bind(this);
    this.openPropertiesDialog = this.openPropertiesDialog.bind(this);

    this.node = React.createRef();
    this.handleEvent = this.handleEvent.bind(this);
  }

  render() {
    const style = { height: '100%' };
    const canvasConfig = {
      enableInternalObjectModel: true,
      enablePaletteLayout: 'Modal',
      paletteInitialState: false
    };
    const toolbarConfig = [
       { action: 'add', label: 'Add Notebook to Pipeline', enable: true, iconEnabled: '/'},
       { divider: true },
       { action: 'run', label: 'Run Pipeline', enable: true },
       { divider: true },
       { action: 'save', label: 'Save Pipeline', enable: true },
       { divider: true },
       // { action: 'open', label: 'Open Pipeline', enable: true },
       // { divider: true },
       { action: 'new', label: 'New Pipeline', enable: true },
       { divider: true },
       { action: 'clear', label: 'Clear Pipeline', enable: true },
       { divider: true },
       { action: 'undo', label: 'Undo', enable: true },
       { action: 'redo', label: 'Redo', enable: true },
       { action: 'cut', label: 'Cut', enable: false },
       { action: 'copy', label: 'Copy', enable: false },
       { action: 'paste', label: 'Paste', enable: false },
       { action: 'addComment', label: 'Add Comment', enable: true },
       { action: 'delete', label: 'Delete', enable: true },
       { action: 'arrangeHorizontally', label: 'Arrange Horizontally', enable: true },
       { action: 'arrangeVertically', label: 'Arrange Vertically', enable: true } ];

    const propertiesCallbacks = {
      applyPropertyChanges: this.applyPropertyChanges,
      closePropertiesDialog: this.closePropertiesDialog
    };

    const commProps = this.state.showPropertiesDialog ? <IntlProvider key='IntlProvider2' locale={ 'en' } messages={ i18nData.messages }>
        <CommonProperties
          propertiesInfo={this.propertiesInfo}
          propertiesConfig={{ }}
          callbacks={propertiesCallbacks}
        />
      </IntlProvider> : null;

    return (
      <div style={style} ref={this.node}>
        <CommonCanvas
          canvasController={this.canvasController}
          toolbarMenuActionHandler={this.toolbarMenuActionHandler}
          contextMenuHandler={this.contextMenuHandler}
          contextMenuActionHandler={this.contextMenuActionHandler}
          editActionHandler={this.editActionHandler}
          toolbarConfig={toolbarConfig}
          config={canvasConfig}
        />
        {commProps}
      </div>
      );
  }

  propertiesInfo = { 'parameterDef': properties, 'appData': { 'id': '' } };

  openPropertiesDialog(source: any) {
    console.log('Opening properties dialog');
    let node_id = source.targetObject.id;
    let app_data = this.canvasController.getNode(node_id).app_data;

    let node_props = this.propertiesInfo;
    node_props.appData.id = node_id;

    node_props.parameterDef.current_parameters.image = app_data.image;
    node_props.parameterDef.current_parameters.outputs = app_data.outputs;
    node_props.parameterDef.current_parameters.vars = app_data.vars;
    node_props.parameterDef.current_parameters.dependencies = app_data.dependencies;
    node_props.parameterDef.current_parameters.recursive_dependencies = app_data.recursive_dependencies;

    this.setState({showPropertiesDialog: true, propertiesInfo: node_props});
  }

  applyPropertyChanges(propertySet: any, appData: any) {
    console.log('Applying changes to properties');
    let app_data = this.canvasController.getNode(appData.id).app_data;

    app_data.image = propertySet.image;
    app_data.outputs = propertySet.outputs;
    app_data.vars = propertySet.vars;
    app_data.dependencies = propertySet.dependencies;
    app_data.recursive_dependencies = propertySet.recursive_dependencies;
  };

  closePropertiesDialog() {
    console.log('Closing properties dialog');
    this.setState({showPropertiesDialog: false, propertiesInfo: {}});
  };

  contextMenuHandler(source: any, defaultMenu: any) {
    let customMenu = defaultMenu;
    if (source.type === 'node') {
      if (source.selectedObjectIds.length > 1) {
        customMenu = customMenu.concat({ action: 'openNotebook', label: 'Open Notebooks'});
      } else {
        customMenu = customMenu.concat({ action: 'openNotebook', label: 'Open Notebook'});
      }
      customMenu = customMenu.concat({ action: 'properties', label: 'Properties'});
    }
    return customMenu;
  }

  contextMenuActionHandler( action: any, source: any ) {
    if (action === 'openNotebook' && source.type === 'node') {
      let nodes = source.selectedObjectIds;
      for (let i = 0; i < nodes.length; i++) {
        let path = this.canvasController.getNode(nodes[i]).app_data.artifact;
        this.app.commands.execute(commandIDs.openDocManager, {path});
      }
    } else if (action === 'properties' && source.type === 'node') {
      if (this.state.showPropertiesDialog) {
        this.closePropertiesDialog();
      } else {
        this.openPropertiesDialog(source);
      }
    }
  }

  /*
   * Handles creating new nodes in the canvas
   */
  editActionHandler(data: any) {
    this.widgetContext.model.fromJSON(this.canvasController.getPipelineFlow());
  }

  handleAdd() {
    let failedAdd = 0;

    toArray(this.browserFactory.defaultBrowser.selectedItems()).map(
      item => {
        // if the selected item is a file
        if (item.type == 'notebook') {
          //add each selected notebook
          console.log('Adding ==> ' + item.path );

          this.position += 20;
          const nodeTemplate = this.canvasController.getPaletteNode('execute-notebook-node');
          if (nodeTemplate) {
            const data = {
              'editType': 'createNode',
              'offsetX': 75 + this.position,
              'offsetY': 85 + this.position,
              'nodeTemplate': this.canvasController.convertNodeTemplate(nodeTemplate)
            };

            data.nodeTemplate.label = item.path.replace(/^.*[\\\/]/, '');
            data.nodeTemplate.label = data.nodeTemplate.label.replace(/\.[^/.]+$/, '');
            data.nodeTemplate.app_data['artifact'] = item.path;
            data.nodeTemplate.app_data['image'] = this.propertiesInfo.parameterDef.current_parameters.image;

            this.canvasController.editActionHandler(data);
          }
        } else {
          failedAdd++;
        }
      }
    )

    if (failedAdd) {
      return showDialog({
        title: 'Unsupported File(s)',
        body: 'Currently only notebook files can be added to a pipeline',
        buttons: [Dialog.okButton()]
      });
    }
  }

  handleRun() {
    // use ServerConnection utility to make calls to Jupyter Based services
    // which in this case are the in the extension installed by this package
    let settings = ServerConnection.makeSettings();
    let runtime_url = URLExt.join(settings.baseUrl, 'metadata/runtime');

    ServerConnection.makeRequest(runtime_url, { method: 'GET' }, settings).then(res => res.json())
      .then(runtimes => {
        return showDialog({
          title: 'Run pipeline',
          body: new PipelineDialog({"runtimes": runtimes}),
          buttons: [Dialog.cancelButton(), Dialog.okButton()]
        }).then( result => {
          if( result.value == null) {
            // When Cancel is clicked on the dialog, just return
            return;
          }

          // prepare pipeline submission details
          console.log('Pipeline definition:');
          console.log(this.canvasController.getPipelineFlow());

          let pipelineFlow = this.canvasController.getPipelineFlow();
          pipelineFlow.pipelines[0]['app_data']['ui_data']['title'] = result.value.pipeline_name;
          pipelineFlow.pipelines[0]['app_data']['ui_data']['platform'] = result.value.platform;

          let requestBody = JSON.stringify(pipelineFlow);
          let url = URLExt.join(settings.baseUrl, 'scheduler');

          console.log('Submitting pipeline to -> ' + url);
          ServerConnection.makeRequest(url, { method: 'POST', body: requestBody }, settings)
            .then((response: any) => {
              console.log('>>>');
              console.log(response);
              if (response.status === 404) {
                return showDialog({
                  title: 'Error submitting pipeline',
                  body: 'Pipeline scheduler service endpoint not available',
                  buttons: [Dialog.okButton()]
                });
              } else if (response.status !== 200) {
                return showDialog({
                  title: 'Error submitting pipeline',
                  body: 'More details might be available in the JupyterLab console logs',
                  buttons: [Dialog.okButton()]
                });
              }
              response.json().then((data: any) => {
                console.log('>>>');
                console.log(data);
                let dialogTitle: string = 'Job submission to ' + pipelineFlow.pipelines[0]['app_data']['ui_data']['platform'] + ' succeeded';
                let dialogBody = <span>Check the status of your run at <a href={data.url} target='_blank'>Run Details</a></span>;
                return showDialog({
                  title: dialogTitle,
                  body: dialogBody,
                  buttons: [Dialog.okButton()]
                });
              });
            });
        });
      });
  }

  handleSave() {
    this.widgetContext.model.fromJSON(this.canvasController.getPipelineFlow());
    this.widgetContext.save();
  }

  handleOpen() {
    toArray(this.browserFactory.defaultBrowser.selectedItems()).map(
      item => {
        // if the selected item is a file
        if (item.type != 'directory') {
          console.log('Opening ==> ' + item.path );
          this.app.commands.execute(commandIDs.openDocManager, { path: item.path });
        }
      }
    )
  }

  handleNew() {
    // Clears the canvas, then creates a new file and sets the pipeline_name field to the new name.
    this.app.commands.execute(commandIDs.openPipelineEditor);
  }

  handleClear() {
    this.canvasController.clearPipelineFlow();
    this.widgetContext.model.fromJSON(this.canvasController.getPipelineFlow());
    this.position = 10;
  }

  /**
   * Handles submitting pipeline runs
   */
  toolbarMenuActionHandler(action: any, source: any) {
  	console.log('Handling action: ' + action);
  	if(action == 'add') { // When adding a new node to the pipeline
  	  this.handleAdd();
    } else if (action == 'run') { // When executing the pipeline
  	  this.handleRun();
	  } else if (action == 'save') {
      this.handleSave();
    } else if (action == 'open') {
      this.handleOpen();
    } else if (action == 'new') {
      this.handleNew();
    } else if (action == 'clear') {
      this.handleClear();
    }
  }

  componentDidMount(): void {
    let node = this.node.current!;
    node.addEventListener('dragenter', this.handleEvent);
    node.addEventListener('dragover', this.handleEvent);
    node.addEventListener('p-dragover', this.handleEvent);
    node.addEventListener('p-drop', this.handleEvent);
  }

  componentWillUnmount(): void {
    let node = this.node.current!;
    node.removeEventListener('p-drop', this.handleEvent);
    node.removeEventListener('p-dragover', this.handleEvent);
    node.removeEventListener('dragover', this.handleEvent);
    node.removeEventListener('dragenter', this.handleEvent);
  }

  /**
   * Handle the DOM events.
   *
   * @param event - The DOM event.
   */
  handleEvent(event: Event): void {
    switch (event.type) {
      case 'dragenter':
        console.log('dragenter');
        event.preventDefault();
        break;
      case 'dragover':
        console.log('dragover');
        event.preventDefault();
        break;
      case 'p-dragover':
        console.log('p-dragover');
        event.preventDefault();
        event.stopPropagation();
        (event as IDragEvent).dropAction = (event as IDragEvent).proposedAction;
        break;
      case 'p-drop':
        console.log('p-drop');
        event.preventDefault();
        event.stopPropagation();
        this.handleAdd();
        break;
      default:
        break;
    }
  }
}

class PipelineEditorFactory extends ABCWidgetFactory<DocumentWidget> {
  app: JupyterFrontEnd;
  browserFactory: IFileBrowserFactory;

  constructor(options: any) {
    super(options);
    this.app = options.app;
    this.browserFactory = options.browserFactory;
  }

  protected createNewWidget(
    context: DocumentRegistry.Context
  ): DocumentWidget {
    // Creates a blank widget with a DocumentWidget wrapper
    let props = {
      app: this.app,
      browserFactory: this.browserFactory,
      context: context
    };
    const content = new Canvas(props);
    const widget = new DocumentWidget({ content, context, node: document.createElement('div') });
    widget.addClass(PIPELINE_CLASS);
    return widget;
  }
}

/**
 * Initialization data for the pipeline-editor-extension extension.
 */
const extension: JupyterFrontEndPlugin<void> = {
  id: PIPELINE,
  autoStart: true,
  requires: [ICommandPalette, ILauncher, IFileBrowserFactory, ILayoutRestorer, IMainMenu],
  activate: (
    app: JupyterFrontEnd,
    palette: ICommandPalette,
    launcher: ILauncher,
    browserFactory: IFileBrowserFactory,
    restorer: ILayoutRestorer,
    menu: IMainMenu
  ) => {
    console.log('AI Workspace - pipeline-editor extension is activated!');

    // Set up new widget Factory for .pipeline files
    const pipelineEditorFactory = new PipelineEditorFactory({
      name: PIPELINE_FACTORY,
      fileTypes: [PIPELINE],
      defaultFor: [PIPELINE],
      app: app,
      browserFactory: browserFactory
    });

    // Add the default behavior of opening the widget for .pipeline files
    app.docRegistry.addFileType({ name: PIPELINE, extensions: ['.pipeline'], iconClass: PIPELINE_ICON_CLASS});
    app.docRegistry.addWidgetFactory(pipelineEditorFactory);

    const tracker = new WidgetTracker<DocumentWidget>({
      namespace: PIPELINE_EDITOR_NAMESPACE
    });

    pipelineEditorFactory.widgetCreated.connect((sender, widget) => {
      void tracker.add(widget);

      // Notify the widget tracker if restore data needs to update
      widget.context.pathChanged.connect(() => {
        void tracker.save(widget);
      });
    });

    // Handle state restoration
    void restorer.restore(tracker,
    {
      command: commandIDs.openDocManager,
      args: widget => ({
        path: widget.context.path,
        factory: PIPELINE_FACTORY
      }),
      name: widget => widget.context.path
    });

    // Add an application command
    const openPipelineEditorCommand: string = commandIDs.openPipelineEditor;
    app.commands.addCommand(openPipelineEditorCommand, {
      label: args => (args['isPalette'] ? 'New Pipeline Editor' : 'Pipeline Editor'),
      iconClass:  args => (args['isPalette'] ? '' : PIPELINE_ICON_CLASS),
      execute: () => {
        // Creates blank file, then opens it in a new window
        app.commands.execute(commandIDs.newDocManager, {
          type: 'file',
          path: browserFactory.defaultBrowser.model.path,
          ext: '.pipeline'
        })
        .then(model => {
          return app.commands.execute(commandIDs.openDocManager, {
            path: model.path,
            factory: PIPELINE_FACTORY
          });
        });
      }
    });
    // Add the command to the palette.
    palette.addItem({command: openPipelineEditorCommand, args: { isPalette: true }, category: 'Extensions'});
    if (launcher) {
      launcher.add({
        command: openPipelineEditorCommand,
        category: 'Other',
        rank: 3
      });
    }
    // Add new pipeline to the file menu
    menu.fileMenu.newMenu.addGroup(
      [{ command: openPipelineEditorCommand }],
      30
    );
  }
 };
 export default extension;
