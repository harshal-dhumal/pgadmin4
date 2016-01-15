define(
    ['jquery', 'underscore', 'underscore.string', 'pgadmin', 'pgadmin.browser.menu',
     'backbone', 'alertify', 'backform', 'pgadmin.backform', 'wcdocker',
     'pgadmin.alertifyjs'],
function($, _, S, pgAdmin, Menu, Backbone, Alertify, Backform) {

  var pgBrowser = pgAdmin.Browser = pgAdmin.Browser || {};
  var wcDocker = window.wcDocker;

  // It has already been defined.
  // Avoid running this script again.
  if (pgBrowser.Node)
    return pgBrowser.Node;

  pgBrowser.Nodes = pgBrowser.Nodes || {};

  // A helper (base) class for all the nodes, this has basic
  // operations/callbacks defined for basic operation.
  pgBrowser.Node = function() {};

  // Helper function to correctly set up the property chain, for subclasses.
  // Uses a hash of class properties to be extended.
  //
  // It is unlikely - we will instantiate an object for this class.
  // (Inspired by Backbone.extend function)
  pgBrowser.Node.extend = function(props) {
    var parent = this;
    var child;

    // The constructor function for the new subclass is defined to simply call
    // the parent's constructor.
    child = function(){ return parent.apply(this, arguments); };

    // Add static properties to the constructor function, if supplied.
    _.extend(child, parent, _.omit(props, 'callbacks'));

    // Make sure - a child have all the callbacks of the parent.
    child.callbacks = _.extend({}, parent.callbacks, props.callbacks);

    // Registering the node by calling child.Init(...) function
    child.Init.apply(child);

    // Initialize the parent
    this.Init.apply(child);

    return child;
  };

  _.extend(pgAdmin.Browser.Node, Backbone.Events, {
    // Node type
    type: undefined,
    // Label
    label: '',
    title: function(d) {
      return o.label + (d ? (' - ' + d.label) : '');
    },
    hasId: true,
    ///////
    // Initialization function
    // Generally - used to register the menus for this type of node.
    //
    // Also, look at pgAdmin.Browser.add_menus(...) function.
    //
    // NOTE: Override this for each node for initialization purpose
    Init: function() {
      var self = this;
      if (self.node_initialized)
        return;
      self.node_initialized = true;

      pgAdmin.Browser.add_menus([{
        name: 'show_obj_properties', node: self.type, module: self,
        applies: ['object', 'context'], callback: 'show_obj_properties',
        priority: 3, label: '{{ _("Properties...") }}',
        data: {'action': 'edit'}, icon: 'fa fa-pencil-square-o'
      }, {
        name: 'refresh', node: self.type, module: self,
        applies: ['object', 'context'], callback: 'refresh',
        priority: 2, label: '{{ _("Refresh...") }}',
        icon: 'fa fa-refresh'
      }]);

      if (self.canDrop) {
        pgAdmin.Browser.add_menus([{
          name: 'delete_object', node: self.type, module: self,
          applies: ['object', 'context'], callback: 'delete_obj',
          priority: 3, label: '{{ _("Delete/Drop") }}',
          data: {'url': 'drop'}, icon: 'fa fa-trash',
          enable: _.isFunction(self.canDrop) ? function() { return self.canDrop.apply(self, arguments); } : false
        }]);
        if (self.canDropCascade) {
          pgAdmin.Browser.add_menus([{
            name: 'delete_object_cascade', node: self.type, module: self,
            applies: ['object', 'context'], callback: 'delete_obj',
            priority: 3, label: '{{ _("Drop Cascade") }}',
            data: {'url': 'delete'}, icon: 'fa fa-trash',
            enable: (_.isFunction(self.canDropCascade) ?
              function() { return self.canDropCascade.apply(self, arguments); } : true)
          }]);
        }
      }
    },
    ///////
    // Generate a Backform view using the node's model type
    //
    // Used to generate view for the particular node properties, edit,
    // creation.
    getView: function(item, type, el, node, formType, callback, ctx) {
      var that = this;

      if (!this.type || this.type == '')
        // We have no information, how to generate view for this type.
        return null;

      if (this.model) {
        // This will be the URL, used for object manipulation.
        // i.e. Create, Update in these cases
        var urlBase = this.generate_url(item, type, node, false);

        if (!urlBase)
          // Ashamed of myself, I don't know how to manipulate this
          // node.
          return null;

        var attrs = {};

        // In order to get the object data from the server, we must set
        // object-id in the model (except in the create mode).
        if (type !== 'create') {
          attrs[this.model.idAttribute || this.model.prototype.idAttribute ||
            'id'] = node._id;
        }

        // We know - which data model to be used for this object.
        var info = this.getTreeNodeHierarchy.apply(this, [item]),
            newModel = new (this.model.extend({urlRoot: urlBase})) (
                attrs, {node_info: info}
                ),
            groups = Backform.generateViewSchema(
                info, newModel, type, this, node
                );

        if (type == 'create' || type == 'edit') {

          if (callback && ctx) {
              callback = callback.bind(ctx);
          } else {
            callback = function() {
              console.log("Broke something!!! Why we don't have the callback or the context???");
            };
          }

          var onSessionInvalid = function(msg) {

            if(!_.isUndefined(that.statusBar)) {
              that.statusBar.html(msg);
            }
            callback(true);

            return true;
          };

          var onSessionValidated =  function(sessHasChanged) {

            if(!_.isUndefined(that.statusBar)) {
              that.statusBar.empty();
            }

            callback(false, sessHasChanged);
          };

          callback(false, false);

          newModel.on('pgadmin-session:valid', onSessionValidated);
          newModel.on('pgadmin-session:invalid', onSessionInvalid);
        }
        // 'schema' has the information about how to generate the form.
        if (groups) {
          var fields = [];

          // This will contain the actual view
          var view;

          // Create an array from the dictionary with proper required
          // structure.
          _.each(groups, function(val, key) {
            fields.push({label: key, fields: val});
          });

          if (formType == 'fieldset') {
            // It is used to show, edit, create the object in the
            // properties tab.
            view = new Backform.Fieldset({
              el: el, model: newModel, schema: fields
            });
          } else {
            // This generates a view to be used by the node dialog
            // (for create/edit operation).
            view = new Backform.Dialog({
              el: el, model: newModel, schema: fields
            });
          }

          if (!newModel.isNew()) {
            // This is definetely not in create mode
            newModel.fetch()
              .success(function(res, msg, xhr) {
                // We got the latest attributes of the
                // object. Render the view now.
                view.render();
                if (type != 'properties') {
                  $(el).focus();
                }
                newModel.startNewSession();
              })
              .error(function(jqxhr, error, message) {
                // TODO:: We may not want to continue from here
                Alertify.pgNotifier(
                  error, jqxhr,
                  S(
                    "{{ _("Error fetching the properties - %%s!") }}"
                    ).sprintf(message).value()
                  );
              });
          } else {
            // Yay - render the view now!
            $(el).focus();
            view.render();
            newModel.startNewSession();
          }
        }
        return view;
      }

      return null;
    },
    register_node_panel: function() {
      var w = pgBrowser.docker,
        p = w.findPanels('node_props');

      if (p && p.length == 1)
        return;

      p = new pgBrowser.Panel({
          name: 'node_props',
          showTitle: true,
          isCloseable: true,
          isPrivate: true,
          content: '<div class="obj_properties">No object selected!</div>'
        });
      p.load(pgBrowser.docker);
    },
    /******************************************************************
     * This function determines the given item is deletable or not.
     *
     * Override this, when a node is not deletable.
     */
    canDrop: false,
    /************************************************************************
     * This function determines the given item and children are deletable or
     * not.
     *
     * Override this, when a node is not deletable.
     */
    canDropCascade: false,
    // List of common callbacks - that can be used for different
    // operations!
    callbacks: {
      /******************************************************************
       * This function allows to create/edit/show properties of any
       * object depending on the arguments provided.
       *
       * args must be a object containing:
       *   action - create/edit/properties
       *   item   - The properties of the item (tree ndoe item)
       *
       * NOTE:
       * if item is not provided, the action will be done on the
       * currently selected tree item node.
       *
       **/
      show_obj_properties: function(args, item) {
        var t = pgBrowser.tree,
          i = args.item || item || t.selected(),
          d = i && i.length == 1 ? t.itemData(i) : undefined
          o = this,
          l = o.title.apply(this, [d]);

        // Make sure - the properties dialog type registered
        pgBrowser.Node.register_node_panel();

        // No node selected.
        if (!d)
          return;

        var self = this,
            isParent = (_.isArray(this.parent_type) ?
              function(d) {
                return (_.indexOf(self.parent_type, d._type) != -1);
              } : function(d) {
                return (self.parent_type == d._type);
              });

        if (args.action == 'create') {
          // If we've parent, we will get the information of it for
          // proper object manipulation.
          //
          // You know - we're working with RDBMS, relation is everything
          // for us.
          if (self.parent_type && !isParent(d)) {
            // In browser tree, I can be under any node, But - that
            // does not mean, it is my parent.
            //
            // We have some group nodes too.
            //
            // i.e.
            // Tables, Views, etc. nodes under Schema node
            //
            // And, actual parent of a table is schema, not Tables.
            while (i && t.hasParent(i)) {
              i = t.parent(i);
              pd = t.itemData(i);

              if (isParent(pd)) {
                // Assign the data, this is my actual parent.
                d = pd;
                break;
              }
            }
          }

          // Seriously - I really don't have parent data present?
          //
          // The only node - which I know - who does not have parent
          // node, is the Server Group (and, comes directly under root
          // node - which has no parent.)
          if (!d || (this.parent_type != null && !isParent(d))) {
            // It should never come here.
            // If it is here, that means - we do have some bug in code.
            return;
          }

          if (!d)
            return;

          l = S('{{ _("Create - %%s") }}').sprintf(
              [this.label]).value();
          p = pgBrowser.docker.addPanel('node_props',
              wcDocker.DOCK.FLOAT, undefined, {
                  w: (screen.width < 700 ?
                      screen.width * 0.95 : screen.width * 0.5),
                  h: (screen.height < 500 ?
                    screen.height * 0.95 : screen.height * 0.5),
                  x: (screen.width < 700 ? '2%' : '25%'),
                  y: (screen.height < 500 ? '2%' : '25%')
                });
          setTimeout(function() {
            o.showProperties(i, d, p, args.action);
          }, 10);
        } else {
          if (pgBrowser.Node.panels && pgBrowser.Node.panels[d.id] &&
              pgBrowser.Node.panels[d.id].$container) {
            p = pgBrowser.Node.panels[d.id];
            /**  TODO ::
             *  Run in edit mode (if asked) only when it is
             *  not already been running edit mode
             **/
            var mode = p.$container.attr('action-mode');
            if (mode) {
              var msg = '{{ _('Are you sure wish to stop editing the properties of the %%s - "%%s"?') }}';
              if (args.action == 'edit') {
                msg = '{{ _('Are you sure wish to reset the current changes, and reopen the panel for %%s - "%%s"?') }}';
              }

              Alertify.confirm(
                '{{ _('Edit in progress?') }}',
                S(msg).sprintf(o.label, d.label).value(),
                function() {
                  setTimeout(function() {
                    o.showProperties(i, d, p, args.action);
                  }, 10);
                },
                null).show();
            } else {
              setTimeout(function() {
                o.showProperties(i, d, p, args.action);
              }, 10);
            }
          } else {
            p = pgBrowser.docker.addPanel('node_props',
                wcDocker.DOCK.FLOAT, undefined, {
                  w: (screen.width < 700 ?
                      screen.width * 0.95 : screen.width * 0.5),
                  h: (screen.height < 500 ?
                    screen.height * 0.95 : screen.height * 0.5),
                  x: (screen.width < 700 ? '2%' : '25%'),
                  y: (screen.height < 500 ? '2%' : '25%')
                });
            pgBrowser.Node.panels = pgBrowser.Node.panels || {};
            pgBrowser.Node.panels[d.id] = p;

            setTimeout(function() {
              o.showProperties(i, d, p, args.action);
            }, 10);
          }
        }

        p.title(l);
        p.icon('icon-' + this.type);

        // Make sure the properties dialog is visible
        p.focus();
      },
      // Delete the selected object
      delete_obj: function(args, item) {
        var input = args || {};
          obj = this,
          t = pgBrowser.tree,
          i = input.item || item || t.selected(),
          d = i && i.length == 1 ? t.itemData(i) : undefined;

        if (!d)
          return;

        /*
         * Make sure - we're using the correct version of node
         */
        obj = pgBrowser.Nodes[d._type];
        var objName = d.label;

        var msg, title;
        if (input.url == 'delete') {

          msg = S('{{ _('Are you sure you want to drop %%s "%%s" and all the objects that depend on it?"?') }}')
            .sprintf(obj.label, d.label).value();
          title = S('{{ _('Drop CASACDE %%s?') }}').sprintf(obj.label).value();

          if (!(_.isFunction(obj.canDropCascade) ?
                obj.canDropCascade.apply(obj, [d, i]) : obj.canDropCascade)) {
            Alertify.notify(
                S('The %s - "%s" can not be deleted!')
                .sprintf(obj.label, d.label).value(),
                'error',
                10
                );
            return;
          }
        } else {
          msg = S('{{ _('Are you sure you want to drop %%s "%%s"?') }}')
            .sprintf(obj.label, d.label).value();
          title = S('{{ _('Drop %%s?') }}').sprintf(obj.label).value();

          if (!(_.isFunction(obj.canDrop) ?
                obj.canDrop.apply(obj, [d, i]) : obj.canDrop)) {
            Alertify.notify(
                S('The %s - "%s" can not be deleted!')
                .sprintf(obj.label, d.label).value(),
                'error', 10
                );
            return;
          }
        }
        Alertify.confirm(title, msg,
          function() {
            $.ajax({
              url: obj.generate_url(i, input.url, d, true),
              type:'DELETE',
              success: function(res) {
                if (res.success == 0) {
                  pgBrowser.report_error(res.errormsg, res.info);
                } else {
                  var n = t.next(i);
                  if (!n || !n.length)
                    n = t.prev(i);
                  t.remove(i);
                  if (n.length) {
                    t.select(n);
                  }
                }
                return true;
              },
              error: function(jqx) {
                var msg = jqx.responseText;
                /* Error from the server */
                if (jqx.status == 410 || jqx.status == 500) {
                  try {
                    var data = $.parseJSON(jqx.responseText);
                    msg = data.errormsg;
                  } catch (e) {}
                }
                pgBrowser.report_error(
                    S('{{ _('Error dropping %%s: "%%s"') }}')
                      .sprintf(obj.label, objName)
                        .value(), msg);
              }
            });
          },
          null).show()
      },
      // Callback called - when a node is selected in browser tree.
      selected: function(item, data, browser) {
        // Show the information about the selected node in the below panels,
        // which are visible at this time:
        // + Properties
        // + Query (if applicable, otherwise empty)
        // + Dependents
        // + Dependencies
        // + Statistics
        var b = browser || pgBrowser,
            t = b.tree,
            d = data || t.itemData(item);

        // Update the menu items
        pgAdmin.Browser.enable_disable_menus.apply(b, [item]);

        if (d && b) {
          if ('properties' in b.panels &&
              b.panels['properties'] &&
              b.panels['properties'].panel &&
              b.panels['properties'].panel.isVisible()) {
            // Show object properties (only when the 'properties' tab
            // is active).
            this.showProperties(item, d, b.panels['properties'].panel);
          }
          if ('sql' in b.panels &&
              b.panels['sql'] &&
              b.panels['sql'].panel &&
              b.panels['sql'].panel.isVisible()) {
            // TODO:: Show reverse engineered query for this object (when 'sql'
            // tab is active.)
          }
          if ('statistics' in b.panels &&
              b.panels['statistics'] &&
              b.panels['statistics'].panel &&
              b.panels['statistics'].panel.isVisible()) {
            // TODO:: Show statistics for this object (when the 'statistics'
            // tab is active.)
          }
          if ('dependencies' in b.panels &&
              b.panels['dependencies'] &&
              b.panels['dependencies'].panel &&
              b.panels['dependencies'].panel.isVisible()) {
            // TODO:: Show dependencies for this object (when the
            // 'dependencies' tab is active.)
          }
          if ('dependents' in b.panels &&
              b.panels['dependents'] &&
              b.panels['dependents'].panel &&
              b.panels['dependents'].panel.isVisible()) {
            // TODO:: Show dependents for this object (when the 'dependents'
            // tab is active.)
          }
        }
      },
      refresh: function(i) {
        var self = this,
            t = pgBrowser.tree,
            d = t.itemData(i);

        t.unload(i);
        t.setInode((d && d.inode) || false);
        t.deselect(i);

        setTimeout(function() {
          t.select(i);
        }, 10);
      }
    },
    /**********************************************************************
     * A hook (not a callback) to show object properties in given HTML
     * element.
     *
     * This has been used for the showing, editing properties of the node.
     * This has also been used for creating a node.
     **/
    showProperties: function(item, data, panel, action) {
      var that = this,
        tree = pgAdmin.Browser.tree,
        j = panel.$container.find('.obj_properties').first(),
        view = j.data('obj-view'),
        content = $('<div tabindex="1"></div>')
          .addClass('pg-prop-content col-xs-12'),

        // Template function to create the status bar
        createStatusBar = function(location){
            var statusBar = $('<div></div>').addClass(
                      'pg-prop-status-bar'
                      ).appendTo(j);
            if (location == "header") {
                statusBar.appendTo(that.header);
            } else {
                statusBar.prependTo(that.footer);
            }
            that.statusBar = statusBar;
            return statusBar;
        },
        // Template function to create the button-group
        createButtons = function(buttons, location, extraClasses) {
          // arguments must be non-zero length array of type
          // object, which contains following attributes:
          // label, type, extraClasses, register
          if (buttons && _.isArray(buttons) && buttons.length > 0) {
            // All buttons will be created within a single
            // div area.
            var btnGroup =
              $('<div></div>').addClass(
                  'pg-prop-btn-group'
                  ),
              // Template used for creating a button
              tmpl = _.template([
                '<button type="<%= type %>" ',
                'class="btn <%=extraClasses.join(\' \')%>"',
                '<% if (disabled) { %> disabled="disabled"<% } %> >',
                '<i class="<%= icon %>"></i>&nbsp;',
                '<%-label%></button>'
                ].join(' '));
            if (location == "header"){
                btnGroup.appendTo(that.header);
            }else{
                btnGroup.appendTo(that.footer);
            }
            if (extraClasses) {
              btnGroup.addClass(extraClasses);
            }
            _.each(buttons, function(btn) {
              // Create the actual button, and append to
              // the group div

              // icon may not present for this button
              if (!btn.icon) {
                btn.icon = "";
              }
              var b = $(tmpl(btn));
              btnGroup.append(b);
              // Register is a callback to set callback
              // for certain operation for this button.
              btn.register(b);
            });
            return btnGroup;
          }
          return null;
        },
        // Callback to show object properties
        properties = function() {

          if (!content.hasClass('has-pg-prop-btn-group'))
            content.addClass('has-pg-prop-btn-group');

          // We need to release any existing view, before
          // creating new view.
          if (view) {
            // Release the view
            view.remove();
            // Deallocate the view
            delete view;
            view = null;
            // Reset the data object
            j.data('obj-view', null);
          }
          // Make sure the HTML element is empty.
          j.empty();
          that.header = $('<div></div>').addClass(
                      'pg-prop-header'
                      ).appendTo(j);
          that.footer = $('<div></div>').addClass(
                      'pg-prop-footer'
                      ).appendTo(j);
          // Create a view to show the properties in fieldsets
          view = that.getView(item, 'properties', content, data, 'fieldset');
          if (view) {
            // Save it for release it later
            j.data('obj-view', view);

            // Create status bar
            createStatusBar('footer');

            // Create proper buttons

            var buttons = [];
            buttons.push({
              label: '{{ _("Edit") }}', type: 'edit',
              extraClasses: ['btn-primary'],
              icon: 'fa fa-lg fa-pencil-square-o',
              disabled: false,
              register: function(btn) {
                btn.click(function() {
                  onEdit();
                });
              }
            });
            createButtons(buttons, 'header', 'pg-prop-btn-group-above');
          }
          j.append(content);
        },
        editFunc = function() {
          if (action && action == 'properties') {
            action = 'edit';
          }
          panel.$container.attr('action-mode', action);
          // We need to release any existing view, before
          // creating the new view.
          if (view) {
            // Release the view
            view.remove();
            // Deallocate the view
            delete view;
            view = null;
            // Reset the data object
            j.data('obj-view', null);
          }
          // Make sure the HTML element is empty.
          j.empty();

          that.header = $('<div></div>').addClass(
                      'pg-prop-header'
                      ).appendTo(j)
          that.footer = $('<div></div>').addClass(
                      'pg-prop-footer'
                      ).appendTo(j);

          var updateButtons = function(hasError, modified) {

            var btnGroup = this.find('.pg-prop-btn-group'),
                btnSave = btnGroup.find('button[type="save"]'),
                btnReset = btnGroup.find('button[type="reset"]');

            if (hasError || !modified) {
              btnSave.prop('disabled', true);
              btnSave.attr('disabled', 'disabled');
            } else {
              btnSave.prop('disabled', false);
              btnSave.removeAttr('disabled');
            }

            if (!modified) {
              btnReset.prop('disabled', true);
              btnReset.attr('disabled', 'disabled');
            } else {
              btnReset.prop('disabled', false);
              btnReset.removeAttr('disabled');
            }
          };

          // Create a view to edit/create the properties in fieldsets
          view = that.getView(item, action, content, data, 'dialog', updateButtons, j);
          if (view) {
            // Save it to release it later
            j.data('obj-view', view);

            // Create proper buttons
            createButtons([{
              label: '{{ _("Save") }}', type: 'save',
              extraClasses: ['btn-primary'],
              icon: 'fa fa-lg fa-save',
              disabled: true,
              register: function(btn) {
                // Save the changes
                btn.click(function() {
                  var m = view.model,
                    d = m.toJSON(true);
                  if (d && !_.isEmpty(d)) {
                    m.save({}, {
                      attrs: d,
                      validate: false,
                      cache: false,
                      success: function() {
                        onSaveFunc.call();
                      },
                      error: function(m, jqxhr) {
                        Alertify.pgNotifier(
                          "error", jqxhr,
                          S(
                            "{{ _("Error during saving properties - %%s!") }}"
                            ).sprintf(jqxhr.statusText).value()
                          );
                      }
                    });
                  }
                });
              }
            },{
              label: '{{ _('Cancel') }}', type: 'cancel',
              extraClasses: ['btn-danger'],
              icon: 'fa fa-lg fa-close',
              disabled: false,
              register: function(btn) {
                btn.click(function() {
                  // Removing the action-mode
                  panel.$container.removeAttr('action-mode');
                  onCancelFunc.call(arguments);
                });
              }
            },{
              label: '{{ _("Reset") }}', type: 'reset',
              extraClasses: ['btn-warning'],
              icon: 'fa fa-lg fa-recycle',
              disabled: true,
              register: function(btn) {
                btn.click(function() {
                  setTimeout(function() { editFunc.call(); }, 0);
                });
              }
            }],'footer' ,'pg-prop-btn-group-below');
          };

          // Create status bar.
          createStatusBar('footer');

          // Add some space, so that - button group does not override the
          // space
          content.addClass('pg-prop-has-btn-group-below');

          // Show contents before buttons
          j.prepend(content);
        },
        closePanel = function() {
          // Closing this panel
          panel.close()
        },
        updateTreeItem = function() {
          // Update the item lable (if lable is modified.)
          if (view.model.tnode) {
            var itemData = tree.itemData(item),
                icon = itemData.icon;

            tree.removeIcon(item);
            _.extend(itemData, {icon: icon}, view.model.tnode);
            tree.setLabel(item, {label: itemData.label});
            tree.addIcon(item, {icon: itemData.icon});
          } else if (view.model.get('name')) {
            tree.setLabel(item, {label: view.model.get("name")});
          }
          panel.$container.removeAttr('action-mode');
          setTimeout(function() { closePanel(); }, 0);
        },
        saveNewNode = function() {
          /* TODO:: Create new tree node for this */
          if (view.model.tnode) {
            var d = _.extend({}, view.model.tnode),
              func = function(i) {
                setTimeout(function() {
                  closePanel();
                }, 0);
                if (i) {
                  tree.select(i, {focus: true});
                }
              }, found = false;

            delete view.model.tnode;

            if (that.parent_type) {
              if (tree.wasLoad(item)) {
                var first = tree.first(item, false),
                    data = first && first.length && tree.itemData(first);

                // We found the same type of object here, we can append it
                // here.
                if (data && data._type == that.type) {
                  tree.append(item, {
                    itemData: d,
                    success: function(i, o) {
                      func(o.items.eq(0));
                    }
                  });
                  return;
                } else {
                  var children = tree.children(item, false, false);

                  if (children) {
                    _.each(children, function(child) {
                      if (found)
                        return;
                      var j = $(child);
                      data = tree.itemData(j);

                      if (data && data._type && data._type in pgBrowser.Nodes) {
                        node = pgBrowser.Nodes[data._type];

                        if (node && node.node && node.node == that.type) {
                          found = true;
                          if (tree.wasLoad(j)) {
                            tree.append(j, {
                              itemData: d,
                              success: function(i, o) {
                                func(o.items.eq(0));
                              }
                            });
                          } else {
                            /*
                             * This is not yet loaded, hence - we need to expand
                             * it, and find the actual object.
                             */
                            if (!tree.isInode(j)) {
                              tree.setInode(j);
                            }
                            tree.open(j, {
                              success: function() {
                                var children = tree.children(j, false, false),
                                    stop = false;

                                _.each(children, function(child) {

                                  if (stop)
                                    return;

                                  var j = $(child),
                                      data = tree.itemData(j);

                                  if (d._id == data._id) {
                                    stop = true;
                                    func(j);
                                  }
                                });
                                func(null);
                              },
                              fail: function() {
                                console.log(arguments);
                              }
                            });
                          }
                        }
                      }
                    });
                  }
                }
                /*
                 * We already added the node at required place, stop going
                 * ahead.
                 */
                if (found)
                  return;

                /* When no children found, it was loaded.
                 * It sets the item to non-inode.
                 */
                if (!tree.isInode(item)) {
                    tree.setInode(item);
                }
                tree.open(item, {
                  success: function() {
                    var s = tree.search(item, {
                      search: d.id,
                      callback: function(i, s) {
                        var data = tree.itemData(i);

                        return (d._id == data._id);
                      },
                      success: function(i, o) {
                        func(i);
                      },
                      fail: function() {
                        console.log(arguments);
                      }
                    });

                  },
                  fail: function() {
                    console.log(arguments);
                  }
                });
              }
            } else {
              tree.append(null, {
                itemData: d,
                success: function(i, o) {
                  func(i);
                }
              });
            }
          }
        },
        editInNewPanel = function() {
          // Open edit in separate panel
          setTimeout(function() {
            that.callbacks.show_obj_properties.apply(that, [{
              'action': 'edit',
              'item': item
            }]);
          }, 0);
        },
        onCancelFunc = closePanel,
        onSaveFunc = updateTreeItem,
        onEdit = editFunc;

      if (action) {
        if (action == 'create'){
          onCancelFunc = closePanel;
          onSaveFunc = saveNewNode;
        }
        if (action != 'properties') {
          // We need to keep track edit/create mode for this panel.
          editFunc();
        } else {
          properties();
        }
      } else {
        /* Show properties */
        properties();
        onEdit = editInNewPanel;
      }
    },
    /**********************************************************************
     * Generate the URL for different operations
     *
     * arguments:
     *   type:  Create/drop/edit/properties/sql/depends/statistics
     *   d:     Provide the ItemData for the current item node
     *   with_id: Required id information at the end?
     *
     * Supports url generation for create, drop, edit, properties, sql,
     * depends, statistics
     */
    generate_url: function(item, type, d, with_id, info) {
      var url = pgAdmin.Browser.URL + '{TYPE}/{REDIRECT}{REF}',
        opURL = {
          'create': 'obj', 'drop': 'obj', 'edit': 'obj',
          'properties': 'obj', 'statistics': 'stats'
        },
        ref = '', self = this,
        priority = -Infinity;

      info = (_.isUndefined(item) || _.isNull(item)) ?
        info || {} : this.getTreeNodeHierarchy(item);

      if (self.parent_type) {
        if (_.isString(self.parent_type)) {
          var p = info[self.parent_type];
          if (p) {
            priority = p.priority;
          }
        } else {
          _.each(self.parent_type, function(o) {
            var p = info[o];
            if (p) {
              if (priority < p.priority) {
                priority = p.priority;
              }
            }
          });
        }
      }

      _.each(
        _.sortBy(
          _.values(
           _.pick(info,
            function(v, k, o) {
              return (v.priority <= priority);
            })
           ),
          function(o) { return o.priority; }
          ),
        function(o) {
          ref = S('%s/%s').sprintf(ref, encodeURI(o._id)).value();
        });

      ref = S('%s/%s').sprintf(
          ref, with_id && d._type == self.type ? d._id : ''
          ).value();

      var args = {
        'TYPE': self.type,
        'REDIRECT': (type in opURL ? opURL[type] : type),
        'REF': ref
      };

      return url.replace(/{(\w+)}/g, function(match, arg) {
        return args[arg];
      });
    },
    // Base class for Node Data Collection
    Collection: Backbone.Collection.extend({
      // Model collection
      initialize: function(attributes, options) {
        var self = this;

        options = options || {};
        /*
         * Session changes will be kept in this object.
         */
        self.sessAttrs = {
          'changed': [],
          'added': [],
          'deleted': [],
          'invalid': []
        };
        self.top = options.top || self;
        self.attrName = options.attrName;
        self.handler = options.handler;
        self.trackChanges = false;

        /*
         * Listen to the model changes for the session changes.
         */
        self.on('add', self.onModelAdd);
        self.on('remove', self.onModelRemove);
        self.on('change', self.onModelChange);

        /*
         * We need to start the session, if the handler is already in session
         * tracking mode.
         */
        if (self.handler && self.handler.trackChanges) {
          self.startNewSession();
        }

        return self;
      },
      startNewSession: function() {
        var self = this;

        if (self.trackChanges) {
          // We're stopping the existing session.
          self.trigger('pgadmin-session:stop', self);

          self.off('pgadmin-session:model:invalid', self.onModelInvalid);
          self.off('pgadmin-session:model:valid', self.onModelValid);
        }

        self.trackChanges = true;
        self.sessAttrs = {
          'changed': [],
          'added': [],
          'deleted': [],
          'invalid': []
        };

        _.each(self.models, function(m) {
          if ('startNewSession' in m && _.isFunction(m.startNewSession)) {
            m.startNewSession();
          }
          if ('validate' in m && typeof(m.validate) === 'function') {
            var msg = m.validate();

            if (msg) {
              self.sessAttrs['invalid'].push(m);
            }
          }
        });

        // Let people know, I have started session hanlding
        self.trigger('pgadmin-session:start', self);

        self.on('pgadmin-session:model:invalid', self.onModelInvalid);
        self.on('pgadmin-session:model:valid', self.onModelValid);
      },
      onModelInvalid: function(msg, m) {
        var self = this;

        if (self.trackChanges) {
          // Do not add the existing invalid object
          if (self.objFindInSession(m, 'invalid') == -1) {
            self.sessAttrs['invalid'].push(m);

            // Inform the parent that - I am an invalid object.
            if (self.handler) {
              (self.handler).trigger('pgadmin-session:model:invalid', msg, self);
            }
          }
        }

        return true;
      },
      onModelValid: function(m) {
        var self = this;

        if (self.trackChanges) {
          // Find the object the invalid list, if found remove it from the list
          // and inform the parent that - I am a valid object now.
          var idx = self.objFindInSession(m, 'invalid');
          if (idx != -1) {
            self.sessAttrs['invalid'].splice(m, 1);

            // Inform the parent that - I am the valid object.
            if (self.handler) {
              (self.handler).trigger('pgadmin-session:model:valid', self);
            } else {
              self.trigger('pgadmin-session:valid', self.sessChanged(), self);
            }
          }
        }

        return true;
      },
      stopSession: function() {
        var self = this;

        self.trackChanges = false;
        self.sessAttrs = {
          'changed': [],
          'added': [],
          'deleted': [],
          'invalid': []
        };

        _.each(self.models, function(m) {
          if ('stopSession' in m && _.isFunction(m.stopSession)) {
            m.stopSession();
          }
        });
      },
      sessChanged: function() {
        return (
            this.sessAttrs['changed'].length > 0 ||
            this.sessAttrs['added'].length > 0 ||
            this.sessAttrs['deleted'].length > 0
            );
      },
      /*
       * We do support the changes through session tracking in general.
       *
       * In normal mode, we will use the general toJSON(..) function of
       * Backbone.Colletion.
       *
       * In session mode, we will return session changes as:
       * We will be returning the session changes as:
       * {
       *  'added': [JSON of each new model],
       *  'delete': [JSON of each deleted model],
       *  'changed': [JSON of each modified model with session changes]
       * }
       */
      toJSON: function(session) {
        var self = this,
            session = (typeof(session) != "undefined" && session == true);

        if (!session) {
          return Backbone.Collection.prototype.toJSON.call(self);
        } else {
          var res = {};

          res['added'] = [];
          _.each(this.sessAttrs['added'], function(o) {
            res['added'].push(o.toJSON());
          });
          if (res['added'].length == 0) {
            delete res['added'];
          }
          res['changed'] = [];
          _.each(self.sessAttrs['changed'], function(o) {
            res['changed'].push(o.toJSON(true));
          });
          if (res['changed'].length == 0) {
            delete res['changed'];
          }
          res['deleted'] = [];
          _.each(self.sessAttrs['deleted'], function(o) {
            res['deleted'].push(o.toJSON());
          });
          if (res['deleted'].length == 0) {
            delete res['deleted'];
          }

          return (_.size(res) == 0 ? null : res);
        }
      },
      objFindInSession: function(m, type) {
        var hasPrimaryKey = m.primary_key &&
              typeof(m.primary_key) == 'function',
            key = hasPrimaryKey ? m.primary_key() : m.cid,
            comparator = hasPrimaryKey ? function(o) {
              return (o.primary_key() === key);
            } : function(o) {
              return (o.cid === key);
            };

        return (_.findIndex(this.sessAttrs[type], comparator));
      },
      onModelAdd: function(obj) {

        if (!this.trackChanges)
          return true;

        var self = this,
            msg,
            isAlreadyInvalid = (_.size(self.sessAttrs['invalid']) != 0),
            idx = self.objFindInSession(obj, 'deleted');

        if ('validate' in obj && typeof(obj.validate) === 'function') {
          msg = obj.validate();

          if (msg) {
            self.sessAttrs['invalid'].push(obj);
          }
        }

        // Hmm.. - it was originally deleted from this collection, we should
        // remove it from the 'deleted' list.
        if (idx >= 0) {
          self.sessAttrs['deleted'].splice(idx, 1);

          // It has been changed originally!
          if ((!'sessChanged' in obj) || obj.sessChanged()) {
            self.sessAttrs['changed'].push(obj);
          }

          (self.handler || self).trigger('pgadmin-session:added', self, obj);

          /*
           * If the collection was already invalid, we don't need to inform the
           * parent, or raise the event for the invalid status.
           */
          if (!isAlreadyInvalid && !_.isUndefined(msg)) {
            if (self.handler) {
              self.handler.trigger('pgadmin-session:model:invalid', msg, self);
            } else {
              self.trigger('pgadmin-session:invalid', msg, self);
            }
          }

          return true;
        }
        self.sessAttrs['added'].push(obj);

        /*
         * Session has been changed
         */
        (self.handler || self).trigger('pgadmin-session:added', self, obj);

        /*
         * If the collection was already invalid, we don't need to inform the
         * parent, or raise the event for the invalid status.
         */
        if (!isAlreadyInvalid && !_.isUndefined(msg)) {
          if (self.handler) {
            self.handler.trigger('pgadmin-session:model:invalid', msg, self);
          } else {
            self.trigger('pgadmin-session:invalid', msg, self);
          }
        }

        return true;
      },
      onModelRemove: function(obj) {

        if (!this.trackChanges)
          return true;

        var self = this,
            idx = self.objFindInSession(obj, 'added'),
            copy = _.clone(obj);

        // We need to remove it from the invalid object list first.
        if (idx >= 0) {
          self.sessAttrs['invalid'].splice(idx, 1);
        }

        idx = self.objFindInSession(obj, 'added');
        // Hmm - it was newly added, we can safely remove it.
        if (idx >= 0) {
          self.sessAttrs['added'].splice(idx, 1);

          (self.handler || self).trigger('pgadmin-session:removed', self, copy);

          if (_.size(self.sessAttrs['invalid']) == 0) {
            if (self.handler) {
              self.handler.trigger('pgadmin-session:model:valid', self);
            } else {
              self.trigger('pgadmin-session:valid', self.sessChanged(), self);
            }
          }

          return true;
        }

        // Hmm - it was changed in this session, we should remove it from the
        // changed models.
        idx = self.objFindInSession(obj, 'changed');

        if (idx >= 0) {
          self.sessAttrs['changed'].splice(idx, 1);
          (self.handler || self).trigger('pgadmin-session:removed', self, copy);
        } else {
          (self.handler || self).trigger('pgadmin-session:removed', self, copy);
        }

        self.sessAttrs['deleted'].push(obj);

        /*
         * This object has been remove, that means - we can safely say, it has been
         * modified.
         */
        if (_.size(self.sessAttrs['invalid']) == 0) {
          if (self.handler) {
            self.handler.trigger('pgadmin-session:model:valid', self);
          } else {
            self.trigger('pgadmin-session:valid', true, self);
          }
        }

        return true;
      },
      onModelChange: function(obj) {

        if (!this.trackChanges || !(obj instanceof pgBrowser.Node.Model))
          return true;

        var self = this,
            idx = self.objFindInSession(obj, 'added');

        // It was newly added model, we don't need to add into the changed
        // list.
        if (idx >= 0) {
          (self.handler || self).trigger('pgadmin-session:changed', self, obj);

          return true;
        }

        idx = self.objFindInSession(obj, 'changed');

        if (!'sessChanged' in obj) {
          (self.handler || self).trigger('pgadmin-session:changed', self, obj);

          if (idx >= 0) {
            return true;
          }

          self.sessAttrs['changed'].push(obj);

          return true;
        }

        if (idx >= 0) {


          if (!obj.sessChanged()) {
            // This object is no more updated, removing it from the changed
            // models list.
            self.sessAttrs['changed'].splice(idx, 1);

            (self.handler || self).trigger('pgadmin-session:changed',self, obj);
            return true;
          }

          (self.handler || self).trigger('pgadmin-session:changed',self, obj);

          return true;
        }

        self.sessAttrs['changed'].push(obj);
        (self.handler || self).trigger('pgadmin-session:changed', self, obj);

        return true;
      }
    }),

    // Base class for Node Data Model
    Model: Backbone.Model.extend({
      /*
       * Parsing the existing data
       */
      parse: function(res) {
        var self = this;
        if (res && _.isObject(res) && 'node' in res && res['node']) {
          self.tnode = _.extend({}, res.node);
          delete res.node;
        }
        if (self.schema && _.isArray(self.schema)) {
          _.each(self.schema, function(s) {
            var obj, val;
            switch(s.type) {
              case 'collection':
                obj = self.get(s.id);
                val = res[s.id];
                if (_.isArray(val) || _.isObject(val)) {
                  if (!obj || !(obj instanceof Backbone.Collection)) {
                    obj = new (pgBrowser.Node.Collection)(val, {
                      model: ((_.isString(s.model) &&
                               s.model in pgBrowser.Nodes) ?
                              pgBrowser.Nodes[s.model].model : s.model),
                      top: self.top || self,
                      handler: self,
                      parse: true,
                      silent: true,
                      attrName: s.id
                      });
                    self.set(s.id, obj, {silent: true, parse: true});
                  } else {
                    obj.reset(val, {silent: true, parse: true});
                  }
                }
                else {
                  if (obj)
                    delete obj;
                  obj = null;
                }
                self.set(s.id, obj, {silent: true});
                res[s.id] = obj;
                break;
              case 'model':
                obj = self.get(s.id);
                val = res[s.id];
                if (!_.isUndefined(val) && !_.isNull(val)) {
                  if (!obj || !(obj instanceof Backbone.Model)) {
                    if (_.isString(s.model) &&
                        s.model in pgBrowser.Nodes[s.model]) {
                      obj = new (pgBrowser.Nodes[s.model].Model)(
                          obj, {
                            silent: true, top: self.top || self, handler: self,
                            attrName: s.id
                          }
                          );
                    } else {
                      obj = new (s.model)(obj, {
                        silent: true, top: self.top || self, handler: self,
                        attrName: s.id
                      });
                    }
                  }
                  obj.set(val, {parse: true, silent: true});
                } else {
                  if (obj)
                    delete obj;
                  obj = null;
                }
                res[s.id] = obj;
                break;
              default:
                break;
            }
          });
        }
        return res;
      },
      primary_key: function() {
        if (this.keys && _.isArray(this.keys)) {
          var res = {}, self = this;

          _.each(self.keys, function(k) {
            res[k] = self.attributes[k];
          });

          return JSON.stringify(res);
        }
        return this.cid;
      },
      initialize: function(attributes, options) {
        var self = this;

        Backbone.Model.prototype.initialize.apply(self, arguments);

        if (_.isUndefined(options) || _.isNull(options)) {
          options = attributes || {};
          attributes = null;
        }

        self.sessAttrs = {};
        self.origSessAttrs = {};
        self.objects = [];
        self.attrName = options.attrName,
        self.top = (options.top || self.collection && self.collection.top || self.collection || self);
        self.handler = options.handler ||
          (self.collection && self.collection.handler);
        self.trackChanges = false;
        self.errorModel = new Backbone.Model();
        self.node_info = options.node_info;

        if (self.schema && _.isArray(self.schema)) {
          _.each(self.schema, function(s) {
            var obj = self.get(s.id);
            switch(s.type) {
              case 'collection':
                if (!obj || !(obj instanceof pgBrowser.Node.Collection)) {
                  if (_.isString(s.model) &&
                    s.model in pgBrowser.Nodes) {
                    var node = pgBrowser.Nodes[s.model];
                    obj = new (node.Collection)(obj, {
                      model: node.model,
                      top: self.top || self,
                      handler: self,
                      attrName: s.id
                    });
                  } else {
                    obj = new (pgBrowser.Node.Collection)(obj, {
                      model: s.model,
                      top: self.top || self,
                      handler: self,
                      attrName: s.id
                    });
                  }
                }
                break;
              case 'model':
                if (!obj || !(obj instanceof Backbone.Model)) {
                  if (_.isString(s.model) &&
                      s.model in pgBrowser.Nodes[s.model]) {
                    obj = new (pgBrowser.Nodes[s.model].Model)(
                        obj, {
                          top: self.top || self, handler: self, attrName: s.id
                        }
                        );
                  } else {
                    obj = new (s.model)(
                        obj, {
                          top: self.top || self, handler: self, attrName: s.id
                        });
                  }
                }
                break;
              default:
                return;
            }
            obj.name = s.id;
            self.objects.push(s.id);
            self.set(s.id, obj, {silent: true});
          });
        }

        if (self.handler && self.handler.trackChanges) {
          self.startNewSession();
        }

        return self;
      },
      sessChanged: function() {
        var self = this;

        return (_.size(self.sessAttrs) > 0 ||
            _.some(self.objects, function(k) {
              var obj = self.get(k);
              if (!(_.isNull(obj) || _.isUndefined(obj))) {
                return obj.sessChanged();
              }
              return false;
            }));
      },
      sessValid: function() {
        var self = this;
        if ('validate' in self && _.isFunction(self.validate) &&
            _.isString(self.validate.apply(self))) {
          return false;
        }
        return true;
      },
      set: function(key, val, options) {
        var opts = _.isObject(key) ? val : options;

        var res = Backbone.Model.prototype.set.call(this, key, val, options);

        if ((opts&& opts.intenal) || !this.trackChanges) {
          return true;
        }

        if (key != null && res) {
          var attrs = {};
          var self = this;

          attrChanged = function(v, k) {
            if (k in self.objects) {
              return;
            }
            attrs[k] = v;
            if (self.origSessAttrs[k] == v) {
              delete self.sessAttrs[k];
            } else {
              self.sessAttrs[k] = v;
            }
          };

          // Handle both `"key", value` and `{key: value}` -style arguments.
          if (typeof key === 'object') {
            _.each(key, attrChanged);
          } else {
            attrChanged(val, key);
          }

          self.trigger('pgadmin-session:set', self, attrs);

          if ('validate' in self && typeof(self['validate']) === 'function') {

            var msg = self.validate(_.keys(attrs));

            /*
             * If any parent present, we will need to inform the parent - that
             * I have some issues/fixed the issue.
             *
             * If not parent found, we will raise the issue
             */
            if (msg != null) {
              if (self.collection || self.handler) {
                (self.collection || self.handler).trigger(
                    'pgadmin-session:model:invalid', msg, self
                    );
              } else {
                self.trigger('pgadmin-session:invalid', msg, self);
              }
            } else if (_.size(self.errorModel.attributes) == 0) {
              if (self.collection || self.handler) {
                (self.collection || self.handler).trigger(
                    'pgadmin-session:model:valid', self
                    );
              } else {
                self.trigger('pgadmin-session:valid', self.sessChanged(), self);
              }
            }
          }

          return res;
        }
        return res;
      },
      /*
       * We do support modified data only through session by tracking changes.
       *
       * In normal mode, we will use the toJSON function of Backbone.Model.
       * In session mode, we will return all the modified data only. And, the
       * objects (collection, and model) will be return as stringified JSON,
       * only from the parent object.
       */
      toJSON: function(session, method) {
        var self = this, res, isNew = self.isNew();

        session = (typeof(session) != "undefined" && session == true);

        if (!session || isNew) {
          res = Backbone.Model.prototype.toJSON.call(this, arguments);
        } else {
          res = {};
          res[self.idAttribute || '_id'] = self.get(self.idAttribute || '_id');
          res = _.extend(res, self.sessAttrs);
        }

        /*
         * We do have number objects (models, collections), which needs to be
         * converted to JSON data manually.
         */
        _.each(
            self.objects,
            function(k) {
              var obj = self.get(k);
              /*
               * For session changes, we only need the modified data to be
               * transformed to JSON data.
               */
              if (session) {
                if ((obj.sessChanged && obj.sessChanged()) || isNew) {
                  res[k] = obj && obj.toJSON(!isNew);
                  /*
                   * We will run JSON.stringify(..) only from the main object,
                   * not for the JSON object within the objects, that only when
                   * HTTP method is 'GET'.
                   *
                   * We do stringify the object, so that - it will not be
                   * translated to wierd format using jQuery.
                   */
                  if (obj && method && method == 'GET') {
                    res[k] = JSON.stringify(res[k]);
                  }
                } else {
                  delete res[k];
                }
              } else {
                res[k] = (obj && obj.toJSON());
              }
            });
        return res;
      },
      startNewSession: function() {
        var self = this;

        if (self.trackChanges) {
          self.trigger('pgadmin-session:stop', self);
          self.off('pgadmin-session:model:invalid', self.onChildInvalid);
          self.off('pgadmin-session:model:valid', self.onChildValid);
        }

        self.trackChanges = true;
        self.sessAttrs = {};
        self.origSessAttrs = _.clone(self.attributes);

        var res = false;

        _.each(self.objects, function(o) {
          var obj = self.get(o);

          if (_.isUndefined(obj) || _.isNull(obj)) {
            return;
          }

          delete self.origSessAttrs[o];

          if (obj && 'startNewSession' in obj && _.isFunction(obj.startNewSession)) {
            obj.startNewSession();
          }
        });

        // Let people know, I have started session hanlding
        self.trigger('pgadmin-session:start', self);

        // Let me listen to the my child invalid/valid messages
        self.on('pgadmin-session:model:invalid', self.onChildInvalid);
        self.on('pgadmin-session:model:valid', self.onChildValid);

      },
      onChildInvalid: function(msg, obj) {
        var self = this;

        if (self.trackChanges && obj) {
          var objName = obj.attrName;

          if (!objName) {
            var hasPrimaryKey = obj.primary_key &&
                  typeof(obj.primary_key) === 'function';
                key = hasPrimaryKey ? obj.primary_key() : obj.cid,
                comparator = hasPrimaryKey ?
                  function(k) {
                    var o = self.get('k');

                    if (o && o.primary_key() === key) {
                      objName = k;
                      return true;
                    }

                    return false;
                  } :
                  function(k) {
                    var o = self.get(k);

                    if (o.cid === key) {
                      objName = k;
                      return true;
                    }

                    return false;
                  };
            _.findIndex(self.objects, comparator);
          }

          if (objName && !self.errorModel.has(objName)) {
            /*
             * We will trigger error information only once.
             */
            if (!_.size(self.errorModel.attributes)) {
              if (self.handler) {
                (self.handler).trigger('pgadmin-session:model:invalid', msg, self);
              } else  {
                self.trigger('pgadmin-session:invalid', msg, self);
              }
            }
            self.errorModel.set(objName, msg);
          }
        }

        return this;
      },
      onChildValid: function(obj) {
        var self = this;

        if (self.trackChanges && obj) {
          var objName = obj.attrName;

          if (!objName) {
              var hasPrimaryKey = (obj.primary_key &&
                (typeof(obj.primary_key) === 'function'));
              key = hasPrimaryKey ? obj.primary_key() : obj.cid,
              comparator = hasPrimaryKey ?
                function(k) {
                  var o = self.get('k');

                  if (o && o.primary_key() === key) {
                    objName = k;
                    return true;
                  }

                  return false;
                } :
                function(k) {
                  var o = self.get('k');

                  if (o && o.cid === key) {
                    objName = k;
                    return true;
                  }

                  return false;
                };

              _.findIndex(self.objects, comparator);
          }

          if (objName && self.errorModel.has(objName)) {

            self.errorModel.unset(objName);

            /*
             * We will trigger validation information
             */
            if (_.size(self.errorModel.attributes) == 0) {
              if (self.handler) {
                (self.handler).trigger('pgadmin-session:model:valid', self);
              } else  {
                self.trigger(
                    'pgadmin-session:valid', self.sessChanged(), self
                    );
              }
            }
          }
        }
      },
      stopSession: function() {
        var self = this;

        if (self.trackChanges) {
          self.off('pgadmin-session:model:invalid', self.onChildInvalid);
          self.off('pgadmin-session:model:valid', self.onChildValid);
        }

        self.trackChanges = false;
        self.sessAttrs = {};
        self.origSessAttrs = {};

        _.each(self.objects, function(o) {
          var obj = self.get(o);

          if (_.isUndefined(obj) || _.isNull(obj)) {
            return;
          }

          self.origSessAttrs[o] = null;
          delete self.origSessAttrs[o];

          if (obj && 'stopSession' in obj && _.isFunction(obj.stopSession)) {
            obj.stopSession();
          }
        });

        self.trigger('pgadmin-session:stop');
      }
    }),
    getTreeNodeHierarchy: function(i) {
      var idx = 0,
          res = {},
          t = pgBrowser.tree;
      do {
        d = t.itemData(i);
        if (d._type in pgBrowser.Nodes && pgBrowser.Nodes[d._type].hasId) {
          res[d._type] = _.extend({}, d, {
            'priority': idx
          });
          idx -= 1;
        }
        i = t.hasParent(i) ? t.parent(i) : null;
      } while (i);

      return res;
    },
    cache: function(url, node_info, level, data) {
      var cached = this.cached = this.cached || {},
          hash = url,
          min_priority = (
              node_info && node_info[level] && node_info[level].priority
              ) || 0;

      if (node_info) {
        _.each(
            _.sortBy(
              _.values(
                _.pick(
                  node_info,
                  function(v, k, o) {
                    return (v.priority <= min_priority);
                  })),
              function(o) { return o.priority; }),
            function(o) {
              hash = S('%s/%s').sprintf(hash, encodeURI(o._id)).value();
            });
      }

      if (_.isUndefined(data)) {
        return cached[hash];
      }

      var res = cached[hash] = {data: data, at: Date(), level: level};

      return res;
    }
  });

  return pgAdmin.Browser.Node;
});
