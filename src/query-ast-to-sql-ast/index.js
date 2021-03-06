import assert from 'assert'
import { flatMap } from 'lodash'
import AliasNamespace from '../alias-namespace'
import { wrap } from '../util'
import deprecate from 'deprecate'
import { getArgumentValues } from 'graphql/execution/values'

const TABLE_TYPES = [ 'GraphQLObjectType', 'GraphQLUnionType', 'GraphQLInterfaceType' ]

export function queryASTToSqlAST(resolveInfo, options, context) {
  // this is responsible for all the logic regarding creating SQL aliases
  // we need varying degrees of uniqueness and readability
  // force oracle to minify, because it has this 30-character limit on column identifiers
  const namespace = new AliasNamespace(options.dialect === 'oracle' ? true : options.minify)

  // we'll build up the AST representing the SQL recursively
  const sqlAST = {}

  // v0.8 changed the "fieldASTs" property to "fieldNodes". we want to support both
  const fieldNodes = resolveInfo.fieldNodes || resolveInfo.fieldASTs
  assert.equal(fieldNodes.length, 1, 'We thought this would always have a length of 1. FIX ME!!')

  // this represents the parsed query
  const queryAST = fieldNodes[0]
  // resolveInfo.parentType is from the schema, its the GraphQLObjectType that is parent to the current field
  // this allows us to get the field definition of the current field so we can grab that extra metadata
  // e.g. sqlColumn or sqlJoin, etc.
  const parentType = resolveInfo.parentType
  populateASTNode.call(resolveInfo, queryAST, parentType, sqlAST, namespace, 0, options, context)

  // make sure they started this party on a table
  assert.equal(sqlAST.type, 'table', 'Must call joinMonster in a resolver on a field where the type is decorated with "sqlTable".')

  // make sure each "sqlDep" is only specified once at each level. also assign it an alias
  pruneDuplicateSqlDeps(sqlAST, namespace)

  return sqlAST
}

export function populateASTNode(queryASTNode, parentTypeNode, sqlASTNode, namespace, depth, options, context) {
  // first, get the name of the field being queried
  const fieldName = queryASTNode.name.value

  // if this is an internal field (say, for introspection "__typename"), lets ignore it
  if (/^__/.test(fieldName)) {
    sqlASTNode.type = 'noop'
    return
  }

  // then, get the field from the schema definition
  let field = parentTypeNode._fields[fieldName]
  if (!field) {
    throw new Error(`The field "${fieldName}" is not in the ${parentTypeNode.name} type.`)
  }

  // allow for explicit ignoring of fields
  if (field.jmIgnoreAll) {
    sqlASTNode.type = 'noop'
    return
  }

  // this flag will keep track of whether multiple rows are needed
  let grabMany = false
  // the actual type might be wrapped in a GraphQLNonNull type
  let gqlType = stripNonNullType(field.type)

  sqlASTNode.args = getArgumentValues(field, queryASTNode, this.variableValues)

  // if list then mark flag true & get the type inside the GraphQLList container type
  if (gqlType.constructor.name === 'GraphQLList') {
    gqlType = stripNonNullType(gqlType.ofType)
    grabMany = true
  }

  // if its a relay connection, there are several things we need to do
  if (gqlType.constructor.name === 'GraphQLObjectType' && gqlType._fields.edges && gqlType._fields.pageInfo) {
    grabMany = true
    // grab the types and fields inside the connection
    const stripped = stripRelayConnection(gqlType, queryASTNode, this.fragments)
    // reassign those
    gqlType = stripped.gqlType
    queryASTNode = stripped.queryASTNode
    // we'll set a flag for pagination.
    if (field.sqlPaginate) {
      sqlASTNode.paginate = true
      getSortColumns(field, sqlASTNode, context)
    }
  } else {
    if (field.sqlPaginate) {
      throw new Error(`To paginate the ${gqlType.name} type, it must be a GraphQLObjectType that fulfills the relay spec. The type must have a "pageInfo" and "edges" field. https://facebook.github.io/relay/graphql/connections.htm`)
    }
  }
  // the typeConfig has all the keyes from the GraphQLObjectType definition
  const config = gqlType._typeConfig


  // is this a table in SQL?
  if (
    !field.jmIgnoreTable &&
    TABLE_TYPES.includes(gqlType.constructor.name)
    && config.sqlTable
  ) {
    if (depth >= 1) {
      assert(field.sqlJoin || field.sqlBatch || field.junctionTable, `If an Object type maps to a SQL table and has a child which is another Object type that also maps to a SQL table, you must define "sqlJoin", "sqlBatch", or "junctionTable" on that field to tell joinMonster how to fetch it. Or you can ignore it with "jmIgnoreTable". Check the "${fieldName}" field on the "${parentTypeNode.name}" type.`)
    }
    handleTable.call(this, sqlASTNode, queryASTNode, field, gqlType, namespace, grabMany, depth, options, context)
  // is this a computed column from a raw expression?
  } else if (field.sqlExpr) {
    sqlASTNode.type = 'expression'
    sqlASTNode.sqlExpr = field.sqlExpr
    let aliasFrom = sqlASTNode.fieldName = field.name
    if (sqlASTNode.defferedFrom) {
      aliasFrom += '@' + parentTypeNode.name
    }
    sqlASTNode.as = namespace.generate('column', aliasFrom)
  // is it just a column? if they specified a sqlColumn or they didn't define a resolver, yeah
  } else if (field.sqlColumn || !field.resolve) {
    sqlASTNode.type = 'column'
    sqlASTNode.name = field.sqlColumn || field.name
    let aliasFrom = sqlASTNode.fieldName = field.name
    if (sqlASTNode.defferedFrom) {
      aliasFrom += '@' + parentTypeNode.name
    }
    sqlASTNode.as = namespace.generate('column', aliasFrom)
  // or maybe it just depends on some SQL columns
  } else if (field.sqlDeps) {
    sqlASTNode.type = 'columnDeps'
    sqlASTNode.names = field.sqlDeps
  // maybe this node wants no business with your SQL, because it has its own resolver
  } else {
    sqlASTNode.type = 'noop'
  }
}

function handleTable(sqlASTNode, queryASTNode, field, gqlType, namespace, grabMany, depth, options, context) {
  const config = gqlType._typeConfig

  sqlASTNode.type = 'table'
  let sqlTable = config.sqlTable
  if (typeof sqlTable === 'function') {
    sqlTable = sqlTable(sqlASTNode.args || {}, context)
  }
  sqlASTNode.name = sqlTable

  // the graphQL field name will be the default alias for the table
  // if thats taken, this function will just add an underscore to the end to make it unique
  sqlASTNode.as = namespace.generate('table', field.name)

  if (field.orderBy && !sqlASTNode.orderBy) {
    handleOrderBy(sqlASTNode, field, context)
  }

  // tables have child fields, lets push them to an array
  const children = sqlASTNode.children = sqlASTNode.children || []

  sqlASTNode.fieldName = field.name
  sqlASTNode.grabMany = grabMany

  if (field.where) {
    sqlASTNode.where = field.where
  }

  /*
   * figure out if they are doing one-to-many/many-to-many or join/batch
   * and collect the relevant info
   */

  // are they doing a one-to-many sql join?
  if (field.sqlJoin) {
    sqlASTNode.sqlJoin = field.sqlJoin
  // or a many-to-many?
  } else if (field.junctionTable || field.joinTable) {
    assert(field.sqlJoins || field.junctionBatch, 'Must define `sqlJoins` (plural) or `junctionBatch` for a many-to-many.')
    if (field.joinTable) {
      deprecate('The `joinTable` is deprecated. Rename to `junctionTable`.')
    }
    const junctionTable = field.junctionTable || field.joinTable
    sqlASTNode.junctionTable = junctionTable
    // we need to generate an alias for their junction table. we'll just take the alphanumeric characters from the junction table expression
    sqlASTNode.junctionTableAs = namespace.generate('table', junctionTable)
    // are they joining or batching?
    if (field.sqlJoins) {
      sqlASTNode.sqlJoins = field.sqlJoins
    } else {
      children.push({
        ...keyToASTChild(field.junctionTableKey, namespace),
        fromOtherTable: sqlASTNode.junctionTableAs,
      })
      sqlASTNode.junctionBatch = {
        sqlJoin: field.junctionBatch.sqlJoin,
        thisKey: {
          ...columnToASTChild(field.junctionBatch.thisKey, namespace),
          fromOtherTable: sqlASTNode.junctionTableAs
        },
        parentKey: columnToASTChild(field.junctionBatch.parentKey, namespace)
      }
    }
  // or are they doing a one-to-many with batching
  } else if (field.sqlBatch) {
    sqlASTNode.sqlBatch = {
      thisKey: columnToASTChild(field.sqlBatch.thisKey, namespace),
      parentKey: columnToASTChild(field.sqlBatch.parentKey, namespace)
    }
  }

  /*
   * figure out the necessary children. this includes the columns join monster needs, the ones the user needs,
   * and finding out how to map those to the field names
   */

  // the NestHydrationJS library only treats the first column as the unique identifier, therefore we
  // need whichever column that the schema specifies as the unique one to be the first child
  if (!config.uniqueKey) {
    throw new Error(`You must specify the "uniqueKey" on the GraphQLObjectType definition of ${sqlTable}`)
  }
  children.push(keyToASTChild(config.uniqueKey, namespace))

  if (config.alwaysFetch) {
    for (let column of wrap(config.alwaysFetch)) {
      children.push(columnToASTChild(column, namespace))
    }
  }

  // this was created for helping resolve types in union types
  // its been generalized to `alwaysFetch`, as its a useful feature for more than just unions
  if (config.typeHint && [ 'GraphQLUnionType', 'GraphQLInterfaceType' ].includes(gqlType.constructor.name)) {
    deprecate('`typeHint` is deprecated. Use `alwaysFetch` instead.')
    children.push(columnToASTChild(config.typeHint, namespace))
  }

  // go handle the pagination information
  if (sqlASTNode.paginate) {
    handleColumnsRequiredForPagination(sqlASTNode, namespace)
  }

  if (queryASTNode.selectionSet) {
    if (gqlType.constructor.name === 'GraphQLUnionType' || gqlType.constructor.name === 'GraphQLInterfaceType') {
      // union types have special rules for the child fields in join monster
      sqlASTNode.type = 'union'
      sqlASTNode.typedChildren = {}
      handleUnionSelections.call(this, sqlASTNode, children, queryASTNode.selectionSet.selections, gqlType, namespace, depth, options, context)
    } else {
      handleSelections.call(this, sqlASTNode, children, queryASTNode.selectionSet.selections, gqlType, namespace, depth, options, context)
    }
  }
}

// we need to collect all fields from all the fragments requested in the union type and ask for them in SQL
function handleUnionSelections(sqlASTNode, children, selections, gqlType, namespace, depth, options, context, internalOptions = {}) {
  for (let selection of selections) {
    // we need to figure out what kind of selection this is
    switch (selection.kind) {
    case 'Field':
      // has this field been requested once already? GraphQL does not protect against duplicates so we have to check for it
      const existingNode = children.find(child => child.fieldName === selection.name.value && child.type === 'table')
      let newNode = {}
      if (existingNode) {
        newNode = existingNode
      } else {
        children.push(newNode)
      }
      if (internalOptions.defferedFrom) {
        newNode.defferedFrom = internalOptions.defferedFrom
      }
      populateASTNode.call(this, selection, gqlType, newNode, namespace, depth + 1, options, context)
      break
    // if its an inline fragment, it has some fields and we gotta recurse thru all them
    case 'InlineFragment':
      {
        const selectionNameOfType = selection.typeCondition.name.value
        // normally, we would scan for the extra join-monster data on the current gqlType.
        // but the gqlType is the Union. The data isn't there, its on each of the types that make up the union
        // lets find that type and handle the selections based on THAT type instead
        const deferredType = this.schema._typeMap[selectionNameOfType]
        const deferToObjectType = deferredType.constructor.name === 'GraphQLObjectType'
        const handler = deferToObjectType ? handleSelections : handleUnionSelections
        if (deferToObjectType) {
          const typedChildren = sqlASTNode.typedChildren
          children = typedChildren[deferredType.name] = typedChildren[deferredType.name] || []
          internalOptions.defferedFrom = gqlType
        }
        handler.call(this, sqlASTNode, children, selection.selectionSet.selections, deferredType, namespace, depth, options, context, internalOptions)
      }
      break
    // if its a named fragment, we need to grab the fragment definition by its name and recurse over those fields
    case 'FragmentSpread':
      {
        const fragmentName = selection.name.value
        const fragment = this.fragments[fragmentName]
        const fragmentNameOfType = fragment.typeCondition.name.value
        const deferredType = this.schema._typeMap[fragmentNameOfType ]
        const deferToObjectType = deferredType.constructor.name === 'GraphQLObjectType'
        const handler = deferToObjectType ? handleSelections : handleUnionSelections
        if (deferToObjectType) {
          const typedChildren = sqlASTNode.typedChildren
          children = typedChildren[deferredType.name] = typedChildren[deferredType.name] || []
          internalOptions.defferedFrom = gqlType
        }
        handler.call(this, sqlASTNode, children, fragment.selectionSet.selections, deferredType, namespace, depth, options, context, internalOptions)
      }
      break
    default:
      throw new Error('Unknown selection kind: ' + selection.kind)
    }
  }
}

// the selections could be several types, recursively handle each type here
function handleSelections(sqlASTNode, children, selections, gqlType, namespace, depth, options, context, internalOptions = {}) {
  for (let selection of selections) {
    // we need to figure out what kind of selection this is
    switch (selection.kind) {
    // if its another field, recurse through that
    case 'Field':
      // has this field been requested once already? GraphQL does not protect against duplicates so we have to check for it
      const existingNode = children.find(child => child.fieldName === selection.name.value && child.type === 'table')
      let newNode = {}
      if (existingNode) {
        newNode = existingNode
      } else {
        children.push(newNode)
      }
      if (internalOptions.defferedFrom) {
        newNode.defferedFrom = internalOptions.defferedFrom
      }
      populateASTNode.call(this, selection, gqlType, newNode, namespace, depth + 1, options, context)
      break
    // if its an inline fragment, it has some fields and we gotta recurse thru all them
    case 'InlineFragment':
      {
        // check to make sure the type of this fragment (or one of the interfaces it implements) matches the type being queried
        const selectionNameOfType = selection.typeCondition.name.value
        const sameType = selectionNameOfType === gqlType.name
        const interfaceType = (gqlType._interfaces || []).map(iface => iface.name).includes(selectionNameOfType)
        if (sameType || interfaceType) {
          handleSelections.call(this, sqlASTNode, children, selection.selectionSet.selections, gqlType, namespace, depth, options, context, internalOptions)
        }
      }
      break
    // if its a named fragment, we need to grab the fragment definition by its name and recurse over those fields
    case 'FragmentSpread':
      {
        const fragmentName = selection.name.value
        const fragment = this.fragments[fragmentName]
        // make sure fragment type (or one of the interfaces it implements) matches the type being queried
        const fragmentNameOfType = fragment.typeCondition.name.value
        const sameType = fragmentNameOfType === gqlType.name
        const interfaceType = gqlType._interfaces.map(iface => iface.name).indexOf(fragmentNameOfType) >= 0
        if (sameType || interfaceType) {
          handleSelections.call(this, sqlASTNode, children, fragment.selectionSet.selections, gqlType, namespace, depth, options, context, internalOptions)
        }
      }
      break
    default:
      throw new Error('Unknown selection kind: ' + selection.kind)
    }
  }
}


// tell the AST we need a column that perhaps the user didnt ask for, but may be necessary for join monster to ID
// objects or associate ones across batches
function columnToASTChild(columnName, namespace) {
  return {
    type: 'column',
    name: columnName,
    fieldName: columnName,
    as: namespace.generate('column', columnName)
  }
}

// generate a name for a composite key based on the individual column names smashed together
// slice them to help prevent exceeding oracle's 30-char identifier limit
function toClumsyName(keyArr) {
  return keyArr.map(name => name.slice(0, 3)).join('#')
}

// keys are necessary for deduplication during the hydration process
// this will handle singular or composite keys
function keyToASTChild(key, namespace) {
  if (typeof key === 'string') {
    return {
      type: 'column',
      name: key,
      fieldName: key,
      as: namespace.generate('column', key)
    }
  } else if (Array.isArray(key)) {
    const clumsyName = toClumsyName(key)
    return {
      type: 'composite',
      name: key,
      fieldName: clumsyName,
      as: namespace.generate('column', clumsyName)
    }
  }
}

function handleColumnsRequiredForPagination(sqlASTNode, namespace) {
  if (sqlASTNode.sortKey) {
    assert(sqlASTNode.sortKey.key, '"sortKey" must have "key"')
    assert(sqlASTNode.sortKey.order, '"sortKey" must have "order"')
    // this type of paging uses the "sort key(s)". we need to get this in order to generate the cursor
    for (let column of wrap(sqlASTNode.sortKey.key)) {
      const newChild = {
        type: 'column',
        name: column,
        fieldName: column,
        as: namespace.generate('column', column)
      }
      // if this joining on a "through-table", the sort key is on the threw table instead of this node's parent table
      if (sqlASTNode.junctionTable) {
        newChild.fromOtherTable = sqlASTNode.junctionTableAs
      }
      sqlASTNode.children.push(newChild)
    }
  } else if (sqlASTNode.orderBy) {
    // this type of paging can visit arbitrary pages, so lets provide the total number of items
    // on this special "$total" column which we will compute in the query
    const newChild = {
      type: 'column',
      name: '$total',
      fieldName: '$total',
      as: namespace.generate('column', '$total')
    }
    if (sqlASTNode.junctionTable) {
      newChild.fromOtherTable = sqlASTNode.junctionTableAs
    }
    sqlASTNode.children.push(newChild)
  }
}

// if its a connection type, we need to look up the Node type inside their to find the relevant SQL info
function stripRelayConnection(gqlType, queryASTNode, fragments) {
  // get the GraphQL Type inside the list of edges inside the Node from the schema definition
  const strippedType = gqlType._fields.edges.type.ofType._fields.node.type
  // let's remember those arguments on the connection
  const args = queryASTNode.arguments
  // and then find the fields being selected on the underlying type, also buried within edges and Node
  const edges = spreadFragments(queryASTNode.selectionSet.selections, fragments, gqlType.name)
    .find(selection => selection.name.value === 'edges')
  if (edges) {
    queryASTNode = spreadFragments(edges.selectionSet.selections, fragments, gqlType.name)
      .find(selection => selection.name.value === 'node') || {}
  } else {
    queryASTNode = {}
  }
  // place the arguments on this inner field, so our SQL AST picks it up later
  queryASTNode.arguments = args
  return { gqlType: strippedType, queryASTNode }
}

function stripNonNullType(type) {
  return type.constructor.name === 'GraphQLNonNull' ? type.ofType : type
}

// go through and make sure se only ask for each sqlDep once per table
export function pruneDuplicateSqlDeps(sqlAST, namespace) {
  const childrenToLoopOver = []
  if (sqlAST.children) {
    childrenToLoopOver.push(sqlAST.children)
  }
  if (sqlAST.typedChildren) {
    childrenToLoopOver.push(...Object.values(sqlAST.typedChildren))
  }

  for (let children of childrenToLoopOver) {
    // keep track of all the dependent columns at this depth in a Set (for uniqueness)
    const deps = new Set

    // loop thru each child which has "columnDeps", remove it from the tree, and add it to the set
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      if (child.type === 'columnDeps') {
        child.names.forEach(name => deps.add(name))
        children.splice(i, 1)
      // or if its another table, recurse on it
      } else if (child.type === 'table' || child.type === 'union') {
        pruneDuplicateSqlDeps(child, namespace)
      }
    }

    // now that we collected the "columnDeps", add them all to one node
    // the "names" property will put all the column names in an object as keys
    // the values of this object will be the SQL alias
    const newNode = {
      type: 'columnDeps',
      names: {}
    }
    deps.forEach(name => {
      newNode.names[name] = namespace.generate('column', name)
    })
    children.push(newNode)
  }
}


function getSortColumns(field, sqlASTNode, context) {
  if (field.sortKey) {
    if (typeof field.sortKey === 'function') {
      sqlASTNode.sortKey = field.sortKey(sqlASTNode.args, context)
    } else {
      sqlASTNode.sortKey = field.sortKey
    }
  } else if (field.orderBy) {
    handleOrderBy(sqlASTNode, field, context)
  } else {
    throw new Error('"sortKey" or "orderBy" required if "sqlPaginate" is true')
  }
}

function handleOrderBy(sqlASTNode, field, context) {
  if (typeof field.orderBy === 'function') {
    sqlASTNode.orderBy = field.orderBy(sqlASTNode.args || {}, context)
  } else {
    sqlASTNode.orderBy = field.orderBy
  }
}

// instead of fields, selections can be fragments, which is another group of selections
// fragments can be arbitrarily nested
// this function recurses through and gets the relevant fields
function spreadFragments(selections, fragments, typeName) {
  return flatMap(selections, selection => {
    switch(selection.kind) {
    case 'FragmentSpread':
      const fragmentName = selection.name.value
      const fragment = fragments[fragmentName]
      return spreadFragments(fragment.selectionSet.selections, fragments, typeName)
    case 'InlineFragment':
      if (selection.typeCondition.name.value === typeName) {
        return spreadFragments(selection.selectionSet.selections, fragments, typeName)
      } else {
        return []
      }
    default:
      return selection
    }
  })
}
