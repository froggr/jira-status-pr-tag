import * as core from '@actions/core'
import * as github from '@actions/github'
import * as jira from 'jira-client'

/**
 * The main entry point for the action. This function is called when the action is run.
 * @returns {Promise<void>} A promise that resolves when the action has completed.
 */
async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token')
    const octokit = github.getOctokit(token)

    const response = await octokit.rest.pulls.list({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      state: 'open'
    })

    if (response.status !== 200) {
      core.info('Could not retrieve PR details')
      return
    }

    const jiraApi = new jira.default({
      host: core.getInput('jira-host'),
      protocol: core.getInput('jira-protocol'),
      username: core.getInput('jira-username'),
      password: core.getInput('jira-password')
    })

    const regexSource = core.getInput('ticket-regex')
    const regex = new RegExp(regexSource, 'i')

    // map the PRs to the ticket keys in the title or body of the PR (if any) and filter out any undefined values (i.e. no matches)
    const pullsContainingTicket = response.data
      .map(pr => {
        return {
          pull: pr.number,
          pullLabels: pr.labels.map(l => l.name),
          ticket : (regex.exec(`${pr.title}${pr.body}`)?.shift())?.toUpperCase()
        }
      })
      .filter((v: {ticket: string | undefined}) => v.ticket !== undefined)

    // log the tickets
    core.info(`tickets: ${JSON.stringify(pullsContainingTicket)}`)

    // use the jira api to create a query to list all tickets in the list of tickets
    const jql = `key in (${pullsContainingTicket
      .map((v: {ticket: string | undefined}) => v.ticket)
      .join(',')})`

    // log the jql
    core.info(`jql: ${jql}`)
    core.debug('querying JIRA');
    // execute the query
    const jiraTickets = await jiraApi.searchJira(jql)

    core.debug('mapping issues')
    // extract the ticket status and labels from the response
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ticketData: any[] = jiraTickets.issues.map((issue: any) => {
      return {
        ticket: issue.key,
        status: issue.fields.status.name,
        labels: issue.fields.labels
      }
    })

    // log the ticket statuses
    core.debug(`ticketStatuses: ${JSON.stringify(ticketData)}`)

    // join the ticket statuses with the tickets from the PRs on the ticket key
    const pullWithTicketData = pullsContainingTicket.map(ticket => {
      const ticketStatus = ticketData.find(v => v.ticket === ticket.ticket)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any@ts-nocheck
      core.debug(ticketStatus);
      return {
        pull: ticket.pull,
        ticket: ticket.ticket,
        ticketStatus: ticketStatus?.status,
        ticketLabels: ticketStatus?.labels,
        prLabels: ticket.pullLabels
      }
    })

    // log the ticket statuses with PRs
    core.debug(`ticketStatusesWithPrs: ${JSON.stringify(pullWithTicketData)}`)

    let prefix: string = core.getInput('ticket-prefix')

    // if prefix is undefined or empty or whitespace only, use 'jira' as prefix
    if (!prefix || !prefix.trim()) {
      prefix = 'jira'
    }

    // map ticketstatuseswihprs to a list of labels to add to the PR
    const pullWithLabelData = pullWithTicketData.map(ticket => {
      // replace spaces with underscores and lowercase the status
      const statusClean = ticket.ticketStatus?.toLowerCase().replace(/\s/g, '_')
      core.debug(JSON.stringify(ticket));
      core.debug(statusClean)
      // filter out any existing jira labels and add the new jira label
      let newLabels = ticket.prLabels
        .filter(l => !l.startsWith(`${prefix}:`))
        .concat(`${prefix}:${statusClean}`)
      // add the jira labels to the list of labels to add
      if (ticket.ticketLabels) {
        newLabels = newLabels.concat(
          ticket.ticketLabels.map((l: string) => `${prefix}::label:${l}`)
        )
      }
      return {
        pull: ticket.pull,
        newLabels,
        oldLabels: ticket.prLabels
      }
    })

    // log the labels to add
    core.debug(`labelsToAdd: ${JSON.stringify(pullWithLabelData)}`)

    // now filter the list to only contain items where newlabels is not equal to oldlabels
    const pullsWithLabelsToUpdate = pullWithLabelData.filter(
      (v: {newLabels: string[]; oldLabels: string[]}) =>
        v.newLabels.join(',') !== v.oldLabels.join(',')
    )

    // log the labels to add
    core.debug(
      `labelsToAddFiltered: ${JSON.stringify(pullsWithLabelsToUpdate)}`
    )

    // for all results execute the github api to add the labels to the PR
    for (const labelData of pullsWithLabelsToUpdate) {
      core.info(`Adding labels to PR ${labelData.pull}`)
      core.info(`New labels: ${labelData.newLabels}`)
      core.info(`Old labels: ${labelData.oldLabels}`)
      try {
        await octokit.rest.issues.removeAllLabels({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          issue_number: labelData.pull
        })
        await octokit.rest.issues.addLabels({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          issue_number: labelData.pull,
          labels: labelData.newLabels
        })
      } catch (error) {
        core.warning(`Error adding labels to PR ${labelData.pull}`)
        core.info(`Error: ${error}`)
      }
    }
  } catch (error:any) {
    core.info('oh no');
    core.info(error.message);
    core.info(`Error: ${error}`)
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()
